import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Patch, Put, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import type { Pool } from "pg";
import { AuthorizationService } from "../auth/authorization.service.js";
import { parseOrganizationName } from "../auth/contracts.js";
import { DATABASE_POOL, type AuthPrincipal, type AuthenticatedRequest } from "../auth/session.service.js";
import { parseReadRetentionInput } from "../messages/message.dto.js";
import { MAX_LOGO_BYTES, MAX_LOGO_EDGE, readPngSize } from "./logo.js";

const defaultAuditEvent = "audit.organization.name.update";
const readRetentionAuditEvent = "audit.organization.read_retention.update";
const logoAuditEvent = "audit.organization.logo.update";
const logoRoute = "/api/organization/logo";
const invalidLogoMessage = "Логотип должен быть PNG размером до 512×512";

function readRetentionView(days: number | null): { keepForever: boolean; days: number | null } {
  return days === null ? { keepForever: true, days: null } : { keepForever: false, days };
}

// Логотип отдаётся только с установки: клиенту передаётся относительный путь,
// абсолютный URL не используется.
function organizationLogoUrl(hasLogo: boolean): string | null {
  return hasLogo ? logoRoute : null;
}

function auditOrganizationChange(actorUserId: string, outcome: string, event: string = defaultAuditEvent): void {
  try {
    process.stdout.write(`${JSON.stringify({
      event,
      actorUserId,
      target: { type: "organization", id: "1" },
      outcome
    })}\n`);
  } catch {
    // An audit output failure must not change the authorization or write result.
  }
}

function applyMethodDecorator(
  decorator: MethodDecorator,
  target: object,
  property: string
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  if (!descriptor) throw new Error("Route handler is missing");
  decorator(target, property, descriptor);
}

function applyParameterDecorator(
  decorator: ParameterDecorator,
  constructor: { prototype: object },
  property: string,
  index: number
): void {
  decorator(constructor.prototype, property, index);
}

export class OrganizationController {
  constructor(
    private readonly pool: Pool,
    private readonly authorization: AuthorizationService
  ) {}

  async getOrganization(request: AuthenticatedRequest): Promise<{ name: string; logoUrl: string | null }> {
    if (!request.authPrincipal) {
      throw new HttpException({ code: "UNAUTHORIZED", message: "Требуется вход" }, 401);
    }

    const result = await this.pool.query<{ name: string; has_logo: boolean }>(
      "SELECT name, logo IS NOT NULL AS has_logo FROM organization WHERE id = 1"
    );
    const organization = result.rows[0];
    if (!organization) {
      throw new Error("Organization is not initialized");
    }
    return { name: organization.name, logoUrl: organizationLogoUrl(organization.has_logo) };
  }

  async updateOrganization(
    request: AuthenticatedRequest,
    body: unknown
  ): Promise<{ name: string; logoUrl: string | null }> {
    if (!request.authPrincipal) {
      throw new HttpException({ code: "UNAUTHORIZED", message: "Требуется вход" }, 401);
    }

    const principal: AuthPrincipal = request.authPrincipal;
    try {
      await this.authorization.requireAdministrator(principal);
    } catch (error) {
      auditOrganizationChange(principal.userId, "forbidden");
      throw error;
    }
    const name = parseOrganizationName(body);
    if (!name) {
      auditOrganizationChange(principal.userId, "invalid_request");
      throw new HttpException({ code: "INVALID_REQUEST", message: "Некорректное название" }, 400);
    }

    try {
      const result = await this.pool.query<{ name: string; has_logo: boolean }>(
        "UPDATE organization SET name = $1, updated_at = now() WHERE id = 1 RETURNING name, (logo IS NOT NULL) AS has_logo",
        [name]
      );
      const organization = result.rows[0];
      if (!organization) {
        throw new Error("Organization is not initialized");
      }
      auditOrganizationChange(principal.userId, "updated");
      return { name: organization.name, logoUrl: organizationLogoUrl(organization.has_logo) };
    } catch (error) {
      auditOrganizationChange(principal.userId, "failed");
      throw error;
    }
  }

  /** Отдаёт логотип организации как PNG. Маршрут приватный — сессия обязательна. */
  async getOrganizationLogo(request: AuthenticatedRequest, response: Response): Promise<void> {
    if (!request.authPrincipal) {
      throw new HttpException({ code: "UNAUTHORIZED", message: "Требуется вход" }, 401);
    }

    const result = await this.pool.query<{ logo: Buffer | null }>(
      "SELECT logo FROM organization WHERE id = 1"
    );
    const organization = result.rows[0];
    if (!organization) {
      throw new Error("Organization is not initialized");
    }
    if (!organization.logo) {
      throw new HttpException({ code: "LOGO_NOT_FOUND", message: "Логотип не загружен" }, 404);
    }
    response.status(200).type("image/png").send(organization.logo);
  }

  /** Загружает или заменяет логотип организации. Только администратор. */
  async updateOrganizationLogo(request: AuthenticatedRequest, body: unknown): Promise<void> {
    if (!request.authPrincipal) {
      throw new HttpException({ code: "UNAUTHORIZED", message: "Требуется вход" }, 401);
    }

    const principal: AuthPrincipal = request.authPrincipal;
    try {
      await this.authorization.requireAdministrator(principal);
    } catch (error) {
      auditOrganizationChange(principal.userId, "forbidden", logoAuditEvent);
      throw error;
    }

    const logo = Buffer.isBuffer(body) ? body : null;
    const size = logo === null ? null : readPngSize(logo);
    if (
      logo === null ||
      logo.length < 1 ||
      logo.length > MAX_LOGO_BYTES ||
      size === null ||
      size.width > MAX_LOGO_EDGE ||
      size.height > MAX_LOGO_EDGE
    ) {
      auditOrganizationChange(principal.userId, "invalid_request", logoAuditEvent);
      throw new HttpException({ code: "INVALID_LOGO", message: invalidLogoMessage }, 400);
    }

    try {
      const result = await this.pool.query(
        "UPDATE organization SET logo = $1, logo_updated_at = now(), updated_at = now() WHERE id = 1",
        [logo]
      );
      if (result.rowCount !== 1) {
        throw new Error("Organization is not initialized");
      }
      auditOrganizationChange(principal.userId, "logo_updated", logoAuditEvent);
    } catch (error) {
      auditOrganizationChange(principal.userId, "failed", logoAuditEvent);
      throw error;
    }
  }

  /** Удаляет логотип организации. Только администратор. */
  async deleteOrganizationLogo(request: AuthenticatedRequest): Promise<void> {
    if (!request.authPrincipal) {
      throw new HttpException({ code: "UNAUTHORIZED", message: "Требуется вход" }, 401);
    }

    const principal: AuthPrincipal = request.authPrincipal;
    try {
      await this.authorization.requireAdministrator(principal);
    } catch (error) {
      auditOrganizationChange(principal.userId, "forbidden", logoAuditEvent);
      throw error;
    }

    try {
      const result = await this.pool.query(
        "UPDATE organization SET logo = NULL, logo_updated_at = NULL, updated_at = now() WHERE id = 1"
      );
      if (result.rowCount !== 1) {
        throw new Error("Organization is not initialized");
      }
      auditOrganizationChange(principal.userId, "logo_deleted", logoAuditEvent);
    } catch (error) {
      auditOrganizationChange(principal.userId, "failed", logoAuditEvent);
      throw error;
    }
  }

  async getReadRetention(request: AuthenticatedRequest): Promise<{ keepForever: boolean; days: number | null }> {
    if (!request.authPrincipal) {
      throw new HttpException({ code: "UNAUTHORIZED", message: "Требуется вход" }, 401);
    }

    const result = await this.pool.query<{ read_retention_days: number | null }>(
      "SELECT read_retention_days FROM organization WHERE id = 1"
    );
    const organization = result.rows[0];
    if (!organization) {
      throw new Error("Organization is not initialized");
    }
    return readRetentionView(organization.read_retention_days);
  }

  async updateReadRetention(
    request: AuthenticatedRequest,
    body: unknown
  ): Promise<{ keepForever: boolean; days: number | null }> {
    if (!request.authPrincipal) {
      throw new HttpException({ code: "UNAUTHORIZED", message: "Требуется вход" }, 401);
    }

    const principal: AuthPrincipal = request.authPrincipal;
    try {
      await this.authorization.requireAdministrator(principal);
    } catch (error) {
      auditOrganizationChange(principal.userId, "forbidden", readRetentionAuditEvent);
      throw error;
    }
    const input = parseReadRetentionInput(body);
    if (!input) {
      auditOrganizationChange(principal.userId, "invalid_request", readRetentionAuditEvent);
      throw new HttpException({ code: "INVALID_REQUEST", message: "Некорректный срок хранения" }, 400);
    }

    try {
      const result = await this.pool.query<{ read_retention_days: number | null }>(
        "UPDATE organization SET read_retention_days = $1, updated_at = now() WHERE id = 1 RETURNING read_retention_days",
        [input.days]
      );
      const organization = result.rows[0];
      if (!organization) {
        throw new Error("Organization is not initialized");
      }
      // Смена срока очищает старые записи сразу; бессрочное хранение ничего не удаляет.
      if (input.days !== null) {
        await this.pool.query(
          "DELETE FROM channel_read_journal WHERE read_at < now() - make_interval(days => $1::int)",
          [input.days]
        );
      }
      auditOrganizationChange(principal.userId, "updated", readRetentionAuditEvent);
      return readRetentionView(organization.read_retention_days);
    } catch (error) {
      auditOrganizationChange(principal.userId, "failed", readRetentionAuditEvent);
      throw error;
    }
  }
}

Controller("api/organization")(OrganizationController);
Inject(DATABASE_POOL)(OrganizationController, undefined, 0);
Inject(AuthorizationService)(OrganizationController, undefined, 1);
applyMethodDecorator(Get(), OrganizationController.prototype, "getOrganization");
applyParameterDecorator(Req(), OrganizationController, "getOrganization", 0);
applyMethodDecorator(Patch(), OrganizationController.prototype, "updateOrganization");
applyMethodDecorator(HttpCode(200), OrganizationController.prototype, "updateOrganization");
applyParameterDecorator(Req(), OrganizationController, "updateOrganization", 0);
applyParameterDecorator(Body(), OrganizationController, "updateOrganization", 1);
applyMethodDecorator(Get("read-retention"), OrganizationController.prototype, "getReadRetention");
applyParameterDecorator(Req(), OrganizationController, "getReadRetention", 0);
applyMethodDecorator(Patch("read-retention"), OrganizationController.prototype, "updateReadRetention");
applyMethodDecorator(HttpCode(200), OrganizationController.prototype, "updateReadRetention");
applyParameterDecorator(Req(), OrganizationController, "updateReadRetention", 0);
applyParameterDecorator(Body(), OrganizationController, "updateReadRetention", 1);
applyMethodDecorator(Get("logo"), OrganizationController.prototype, "getOrganizationLogo");
applyParameterDecorator(Req(), OrganizationController, "getOrganizationLogo", 0);
applyParameterDecorator(Res(), OrganizationController, "getOrganizationLogo", 1);
applyMethodDecorator(Put("logo"), OrganizationController.prototype, "updateOrganizationLogo");
applyMethodDecorator(HttpCode(204), OrganizationController.prototype, "updateOrganizationLogo");
applyParameterDecorator(Req(), OrganizationController, "updateOrganizationLogo", 0);
applyParameterDecorator(Body(), OrganizationController, "updateOrganizationLogo", 1);
applyMethodDecorator(Delete("logo"), OrganizationController.prototype, "deleteOrganizationLogo");
applyMethodDecorator(HttpCode(204), OrganizationController.prototype, "deleteOrganizationLogo");
applyParameterDecorator(Req(), OrganizationController, "deleteOrganizationLogo", 0);
