import { randomBytes } from "node:crypto";
import { io } from "socket.io-client";
import {
  applicationOrigin,
  captureExternalRequests,
  expect,
  normalizedNetworkOrigin,
  openSettingsSection,
  test
} from "./fixtures.js";
import type { BrowserContext, Page } from "@playwright/test";

interface Credentials {
  login: string;
  password: string;
}

async function login(page: Page, credentials: Credentials): Promise<void> {
  await page.goto(`${applicationOrigin}/`);
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
}

async function sessionCookie(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies(applicationOrigin)).find(({ name }) => name.endsWith("decentracord.sid"));
  expect(cookie).toBeTruthy();
  return `${cookie!.name}=${cookie!.value}`;
}

async function expectRevokedSession(context: BrowserContext, cookie: string, verifySocketReconnect = false): Promise<void> {
  const response = await context.request.get(`${applicationOrigin}/api/auth/me`, {
    failOnStatusCode: false,
    headers: { cookie }
  });
  expect(response.status()).toBe(401);
  expect(await response.text()).not.toMatch(/password_hash|passwordHash|csrfToken/iu);
  if (!verifySocketReconnect) return;

  const socket: ReturnType<typeof io> = io(`${applicationOrigin}/realtime`, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 5_000,
    transports: ["websocket"],
    extraHeaders: { cookie, origin: applicationOrigin }
  });
  const connected = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), 6_000);
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("connect_error", () => finish(false));
    socket.connect();
  });
  expect(connected).toBe(false);
}

async function loginAsAdministrator(page: Page, credentials: Credentials, organizationName: string): Promise<void> {
  await login(page, credentials);
  await expect(page.getByRole("heading", { name: organizationName })).toBeVisible();
}

test.describe("installation privacy boundary", () => {
  test("guest shell and protected API responses disclose no organization data", async ({ page, context, request, identity }) => {
    expect(normalizedNetworkOrigin(`${applicationOrigin}/healthz`)).toBe(applicationOrigin);
    expect(normalizedNetworkOrigin("wss://outside.invalid/realtime")).toBe("https://outside.invalid");
    expect(normalizedNetworkOrigin("data:text/plain,private")).toBeUndefined();
    const unexpectedRequests = captureExternalRequests(context);
    const shellResponse = await page.goto(`${applicationOrigin}/`);
    expect(shellResponse?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
    const shellHtml = await shellResponse!.text();
    expect(shellHtml).not.toContain(identity.organizationName);
    expect(shellHtml).not.toContain(identity.admin.login);

    const javascriptAssets = await page.evaluate(async () => {
      const scripts = Array.from(document.scripts).filter((script) => script.src);
      return Promise.all(scripts.map(async (script) => {
        const response = await fetch(script.src, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`Application asset returned ${response.status}`);
        return response.text();
      }));
    });
    for (const asset of javascriptAssets) {
      expect(asset).not.toContain(identity.organizationName);
      expect(asset).not.toContain(identity.admin.login);
      expect(asset).not.toContain(identity.admin.password);
    }

    const csp = shellResponse?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    if (process.env.E2E_EXTERNAL_STACK === "1") {
      expect(csp).toContain(`connect-src 'self' ${applicationOrigin} ${applicationOrigin.replace(/^https:/u, "wss:")}`);
    }

    for (const path of [
      "/api/organization",
      "/api/members",
      "/api/roles",
      "/api/channels",
      "/api/messages/00000000-0000-4000-8000-000000000001",
      "/api/not-a-route"
    ]) {
      const response = await request.get(path, { failOnStatusCode: false });
      expect(response.status(), path).toBe(401);
      expect(response.headers()["content-type"], path).toContain("application/json");
      expect(response.headers()["cache-control"], path).toContain("no-store");
      const body = await response.text();
      expect(body).not.toContain(identity.organizationName);
      expect(body).not.toContain(identity.admin.login);
      expect(body).not.toMatch(/password_hash|passwordHash|csrfToken|secret/iu);
    }

    expect(unexpectedRequests).toEqual([]);
  });

  test("account actions use only the installation origin and reject stale or cross-origin sockets", async ({
    browser,
    page,
    context,
    identity
  }) => {
    test.setTimeout(180_000);
    const unexpectedRequests = captureExternalRequests(context);
    const memberLogin = `privacy_${randomBytes(5).toString("hex")}`;
    const issuedPassword = `Privacy-issued-${randomBytes(9).toString("hex")}-Secure`;
    const changedPassword = `Privacy-changed-${randomBytes(9).toString("hex")}-Secure`;
    const resetPassword = `Privacy-reset-${randomBytes(9).toString("hex")}-Secure`;
    const updatedOrganization = `Privacy ${randomBytes(5).toString("hex")}`;
    let organizationChanged = false;
    let employeeContext: BrowserContext | undefined;
    let employeeRequests: string[] = [];

    try {
      await loginAsAdministrator(page, identity.admin, identity.organizationName);
      await openSettingsSection(page, "Организация");
      await page.getByRole("textbox", { name: "Название организации" }).fill(updatedOrganization);
      await page.getByRole("button", { name: "Сохранить название", exact: true }).click();
      await expect(page.getByRole("heading", { name: updatedOrganization, exact: true })).toBeVisible();
      await expect(page.getByText("Название сохранено.", { exact: true })).toBeVisible();
      organizationChanged = true;

      await openSettingsSection(page, "Участники");
      await expect(page.getByRole("heading", { name: "Участники", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Добавить участника", exact: true }).click();
      await page.getByLabel("Логин").fill(memberLogin);
      await page.getByLabel("Пароль").fill(issuedPassword);
      await page.getByRole("button", { name: "Создать участника" }).click();
      await expect(page.getByText("Участник создан. Пароль больше не отображается.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Добавить участника", exact: true }).click();
      await expect(page.getByLabel("Пароль")).toHaveValue("");

      const memberRow = page.locator(".member-list-row").filter({ hasText: memberLogin });
      await expect(memberRow).toHaveCount(1);
      employeeContext = await browser.newContext({ baseURL: applicationOrigin });
      employeeRequests = captureExternalRequests(employeeContext);
      const employeePage = await employeeContext.newPage();
      await login(employeePage, { login: memberLogin, password: issuedPassword });
      await expect(employeePage.getByRole("heading", { name: updatedOrganization, exact: true })).toBeVisible();
      await expect(employeePage.locator(".connection-status")).toContainText("подключено");

      const originalSession = await sessionCookie(employeeContext);
      const crossOriginSocket = io(`${applicationOrigin}/realtime`, {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        timeout: 5_000,
        transports: ["websocket"],
        extraHeaders: { cookie: originalSession, origin: "https://attacker.invalid" }
      });
      const crossOriginConnected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => finish(false), 6_000);
        const finish = (connected: boolean): void => {
          clearTimeout(timer);
          crossOriginSocket.disconnect();
          resolve(connected);
        };
        crossOriginSocket.once("connect", () => finish(true));
        crossOriginSocket.once("connect_error", () => finish(false));
        crossOriginSocket.connect();
      });
      expect(crossOriginConnected).toBe(false);

      await openSettingsSection(employeePage, "Настройки аккаунта");
      await employeePage.getByRole("textbox", { name: "Текущий пароль" }).fill(issuedPassword);
      await employeePage.getByRole("textbox", { name: "Новый пароль" }).fill(changedPassword);
      await employeePage.getByRole("button", { name: "Сменить пароль" }).click();
      await expect(employeePage.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expectRevokedSession(employeeContext, originalSession);

      await login(employeePage, { login: memberLogin, password: changedPassword });
      const logoutSession = await sessionCookie(employeeContext);
      await employeePage.getByRole("button", { name: "Выйти" }).click({ timeout: 10_000 });
      await expect(employeePage.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expectRevokedSession(employeeContext, logoutSession, true);

      const openResetForm = memberRow.getByRole("button", { name: "Сбросить пароль", exact: true });
      await expect(openResetForm).toBeVisible();
      await expect(openResetForm).toBeEnabled();
      await openResetForm.click({ timeout: 5_000 });
      await memberRow.getByLabel(`Новый пароль для ${memberLogin}`).fill(resetPassword);
      const resetForm = memberRow.locator(".member-reset-form");
      await expect(resetForm).toBeVisible();
      const openResetDialog = resetForm.getByRole("button");
      await expect(openResetDialog).toBeEnabled();
      await openResetDialog.click({ timeout: 5_000 });
      const resetDialog = page.getByRole("dialog", { name: "Сбросить пароль" });
      await resetDialog.getByLabel("Подтверждаю завершение всех входов сотрудника").check();
      await resetDialog.getByRole("button", { name: "Сбросить пароль и завершить входы" }).click();
      await expect(memberRow.getByRole("status")).toHaveText("Пароль сброшен. Все прежние сеансы завершены.");
      await memberRow.getByRole("button", { name: "Сбросить пароль" }).click();
      await expect(memberRow.getByLabel(`Новый пароль для ${memberLogin}`)).toHaveValue("");
      await expect(employeePage.getByRole("heading", { name: "Вход" })).toBeVisible();
      await employeePage.getByLabel("Логин").fill(memberLogin);
      await employeePage.getByLabel("Пароль").fill(changedPassword);
      await employeePage.getByRole("button", { name: "Войти" }).click();
      await expect(employeePage.getByRole("alert")).toContainText("Неверный логин или пароль");

      await login(employeePage, { login: memberLogin, password: resetPassword });
      const disabledSession = await sessionCookie(employeeContext);
      await memberRow.getByRole("button", { name: "Отключить" }).click();
      const disableDialog = page.getByRole("dialog", { name: "Отключить участника" });
      await disableDialog.getByLabel("Подтверждаю отключение учётной записи и завершение всех входов").check();
      await disableDialog.getByRole("button", { name: "Отключить участника" }).click();
      await expect(memberRow.getByText("Отключён", { exact: true })).toBeVisible();
      await expect(employeePage.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expectRevokedSession(employeeContext, disabledSession);

      await employeePage.getByLabel("Логин").fill(memberLogin);
      await employeePage.getByLabel("Пароль").fill(resetPassword);
      await employeePage.getByRole("button", { name: "Войти" }).click();
      await expect(employeePage.getByRole("alert")).toContainText("Неверный логин или пароль");
    } finally {
      await employeeContext?.close();
      if (organizationChanged) {
        const administratorRequest = page.context().request;
        const csrfResponse = await administratorRequest.get(`${applicationOrigin}/api/auth/csrf`);
        expect(csrfResponse.status()).toBe(200);
        const csrfPayload = await csrfResponse.json() as { csrfToken?: unknown };
        expect(typeof csrfPayload.csrfToken).toBe("string");
        const response = await administratorRequest.patch(`${applicationOrigin}/api/organization`, {
          data: { name: identity.organizationName },
          failOnStatusCode: false,
          headers: {
            origin: applicationOrigin,
            "x-csrf-token": csrfPayload.csrfToken as string
          }
        });
        expect(response.status()).toBe(200);
      }
    }

    expect(unexpectedRequests).toEqual([]);
    expect(employeeRequests).toEqual([]);
  }, 180_000);
});
