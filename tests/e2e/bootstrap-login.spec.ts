import { existsSync } from "node:fs";
import { test, expect, type TestIdentity } from "./fixtures.js";
import type { BrowserContext, Page, APIRequestContext } from "@playwright/test";

const storageStatePath = process.env.E2E_BOOTSTRAP_STORAGE_STATE_PATH ?? "/e2e-state/bootstrap-session.json";

function employeeIdentity(identity: TestIdentity) {
  if (!identity.employee) throw new Error("Employee fixture is unavailable in this test stage");
  return identity.employee;
}

async function submitLogin(page: Page, credentials: { login: string; password: string }): Promise<void> {
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
}

function sessionCookie(context: BrowserContext, url: string): Promise<string | undefined> {
  return context.cookies(url).then((cookies) => cookies.find((cookie) => cookie.name.endsWith("decentracord.sid"))?.value);
}

async function assertUnauthorizedJson(request: APIRequestContext, pathname: string): Promise<void> {
  const response = await request.get(pathname, { failOnStatusCode: false });
  expect(response.status(), pathname).toBe(401);
  expect(response.headers()["content-type"], pathname).toContain("application/json");
  expect(response.headers()["cache-control"], pathname).toContain("no-store");
  const body = await response.text();
  expect(body).not.toMatch(/password_hash|secret|Organization name/iu);
}

test.describe("browser bootstrap and login", () => {
  test("CLI administrator signs in, sees the database organization, and rotates the pre-login session", async ({
    page,
    context,
    identity
  }) => {
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    const rootResponse = await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Вход" }),
      `root status=${rootResponse?.status()}; browser errors=${browserErrors.join(" | ")}`
    ).toBeVisible();
    await expect(page.getByLabel("Логин")).toBeVisible();
    await expect(page.getByLabel("Пароль")).toBeVisible();

    await expect.poll(() => sessionCookie(context, process.env.E2E_BASE_URL ?? "http://decentracord.test:3000")).toBeTruthy();
    const sessionBeforeLogin = await sessionCookie(context, process.env.E2E_BASE_URL ?? "http://decentracord.test:3000");
    expect(sessionBeforeLogin).toBeTruthy();

    await submitLogin(page, identity.admin);

    await expect(page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
    await expect(page.getByText(identity.admin.login, { exact: true })).toBeVisible();
    const sessionAfterLogin = await sessionCookie(context, process.env.E2E_BASE_URL ?? "http://decentracord.test:3000");
    expect(sessionAfterLogin).toBeTruthy();
    expect(sessionAfterLogin).not.toBe(sessionBeforeLogin);
    const meResponse = await context.request.get("/api/auth/me");
    expect(meResponse.status()).toBe(200);
    const me = await meResponse.json() as Record<string, unknown>;
    expect(Object.keys(me).sort()).toEqual(["id", "login"]);
    expect(me.login).toBe(identity.admin.login);
    expect(await page.content()).not.toMatch(/password_hash|passwordHash|csrfToken/iu);
    await context.storageState({ path: storageStatePath });
  });

  test("employee enters with the issued password without a forced password change", async ({ page, identity }) => {
    const employee = employeeIdentity(identity);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
    await submitLogin(page, employee);
    await expect(page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
    await expect(page.getByText(employee.login, { exact: true })).toBeVisible();
    await expect(page.getByLabel("Новый пароль")).toHaveCount(0);
  });

  test("guest browser shell does not reveal organization data", async ({ page, identity }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
    await expect(page.getByText(identity.organizationName, { exact: true })).toHaveCount(0);
    const publicHtml = await page.content();
    expect(publicHtml).not.toContain(identity.organizationName);
    expect(publicHtml).not.toMatch(/password_hash|csrfToken/iu);
  });

  test("guest API routes return private JSON and reject missing or wrong CSRF tokens", async ({ request, identity }) => {
    for (const pathname of [
      "/api/organization",
      "/api/members",
      "/api/roles",
      "/api/channels",
      "/api/messages/00000000-0000-4000-8000-000000000001",
      "/api/not-a-route"
    ]) {
      await assertUnauthorizedJson(request, pathname);
    }

    const csrfResponse = await request.get("/api/auth/csrf");
    expect(csrfResponse.status()).toBe(200);
    const csrfPayload = await csrfResponse.json() as { csrfToken?: unknown };
    expect(typeof csrfPayload.csrfToken).toBe("string");

    for (const token of [undefined, "wrong-csrf-token"]) {
      const headers: Record<string, string> = { origin: process.env.E2E_BASE_URL ?? "http://decentracord.test:3000" };
      if (token) headers["x-csrf-token"] = token;
      const response = await request.post("/api/auth/login", {
        data: { login: identity.admin.login, password: identity.admin.password },
        failOnStatusCode: false,
        headers
      });
      expect(response.status()).toBe(403);
    }
  });

  test("authenticated session survives application and database restart @session-after-restart", async ({
    browser,
    identity
  }) => {
    expect(existsSync(storageStatePath)).toBe(true);
    const context = await browser.newContext({ storageState: storageStatePath });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      await expect(page.getByText(identity.admin.login, { exact: true })).toBeVisible();
      const me = await context.request.get("/api/auth/me");
      expect(me.status()).toBe(200);
      expect(await me.json()).toMatchObject({ login: identity.admin.login });
    } finally {
      await context.close();
    }
  });
});
