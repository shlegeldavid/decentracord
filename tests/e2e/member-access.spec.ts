import { test, expect, type Browser, type BrowserContext, type Page } from "./fixtures.js";
import type { APIRequestContext } from "@playwright/test";

const applicationOrigin = process.env.E2E_BASE_URL ?? "http://decentracord.test:3000";
const storageStatePath = process.env.E2E_STORAGE_STATE_PATH ?? "/e2e-state/session.json";

async function login(page: Page, credentials: { login: string; password: string }): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("button", { name: "Настройки аккаунта" })).toBeVisible();
}

async function newAuthenticatedPage(
  browser: Browser,
  credentials: { login: string; password: string }
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, credentials);
  return { context, page };
}

async function issueCsrf(request: APIRequestContext): Promise<string> {
  const response = await request.get("/api/auth/csrf");
  expect(response.status()).toBe(200);
  const result = await response.json() as { csrfToken?: unknown };
  expect(typeof result.csrfToken).toBe("string");
  return result.csrfToken as string;
}

async function createMemberFromUi(page: Page, loginValue: string, password: string): Promise<void> {
  await page.getByRole("button", { name: "Участники" }).click();
  await expect(page.getByRole("heading", { name: "Участники" })).toBeVisible();
  await page.getByLabel("Логин").fill(loginValue);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Создать участника" }).click();
  await expect(page.getByText("Участник создан. Пароль больше не отображается.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Пароль")).toHaveValue("");
}

test.describe("administrator member access", () => {
  test("resets a member password and revokes every existing session @reset", async ({ browser, page, identity }) => {
    const targetLogin = `reset_${Date.now().toString(36)}`;
    const oldPassword = "Reset-issued-password-2026";
    const newPassword = `Reset-new-password-${Date.now()}-Secure`;
    const ordinary = identity.employee;
    expect(ordinary).toBeTruthy();
    if (!ordinary) return;

    await login(page, identity.admin);
    await createMemberFromUi(page, targetLogin, oldPassword);
    const adminRequest = page.context().request;
    const token = await issueCsrf(adminRequest);
    const own = await adminRequest.get("/api/auth/me");
    const ownIdentity = await own.json() as { id: string };
    const ownReset = await adminRequest.post(`/api/members/${ownIdentity.id}/reset-password`, {
      data: { newPassword },
      failOnStatusCode: false,
      headers: { origin: applicationOrigin, "x-csrf-token": token }
    });
    expect(ownReset.status()).toBe(409);

    const ordinarySession = await newAuthenticatedPage(browser, ordinary);
    const ordinaryToken = await issueCsrf(ordinarySession.context.request);
    const ordinaryReset = await ordinarySession.context.request.post(`/api/members/${ownIdentity.id}/reset-password`, {
      data: { newPassword },
      failOnStatusCode: false,
      headers: { origin: applicationOrigin, "x-csrf-token": ordinaryToken }
    });
    expect(ordinaryReset.status()).toBe(403);
    await ordinarySession.context.close();

    const first = await newAuthenticatedPage(browser, { login: targetLogin, password: oldPassword });
    const second = await newAuthenticatedPage(browser, { login: targetLogin, password: oldPassword });
    const fresh = await browser.newPage();
    try {
      await expect(first.page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      await expect(second.page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      await expect(first.page.getByRole("status")).toContainText("подключено");
      await expect(second.page.getByRole("status")).toContainText("подключено");

      const row = page.getByRole("listitem").filter({ hasText: targetLogin });
      await row.getByRole("button", { name: "Сбросить пароль" }).click();
      await row.getByLabel(`Новый пароль для ${targetLogin}`).fill(newPassword);
      await row.getByLabel("Подтверждаю завершение всех входов сотрудника").check();
      await row.getByRole("button", { name: "Сбросить пароль и завершить входы" }).click();
      await expect(row.getByRole("status")).toHaveText("Пароль сброшен. Все прежние сеансы завершены.");
      await expect(row.getByLabel(`Новый пароль для ${targetLogin}`)).toHaveValue("");

      await expect(first.page.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expect(second.page.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expect(first.page.getByText(identity.organizationName, { exact: true })).toHaveCount(0);
      await expect(second.page.getByText(identity.organizationName, { exact: true })).toHaveCount(0);
      await first.context.storageState({ path: storageStatePath });

      const firstMe = await first.context.request.get("/api/auth/me", { failOnStatusCode: false });
      const secondMe = await second.context.request.get("/api/auth/me", { failOnStatusCode: false });
      expect(firstMe.status()).toBe(401);
      expect(secondMe.status()).toBe(401);
      expect(await firstMe.text()).not.toMatch(/password_hash|passwordHash/iu);
      expect(await secondMe.text()).not.toMatch(/password_hash|passwordHash/iu);

      await fresh.goto("/");
      await fresh.getByLabel("Логин").fill(targetLogin);
      await fresh.getByLabel("Пароль").fill(oldPassword);
      await fresh.getByRole("button", { name: "Войти" }).click();
      await expect(fresh.getByRole("alert")).toContainText("Неверный логин или пароль");

      await fresh.getByLabel("Логин").fill(targetLogin);
      await fresh.getByLabel("Пароль").fill(newPassword);
      await fresh.getByRole("button", { name: "Войти" }).click();
      await expect(fresh.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      await expect(fresh.getByRole("button", { name: "Настройки аккаунта" })).toBeVisible();
      expect(await page.content()).not.toContain(newPassword);
    } finally {
      await first.context.close();
      await second.context.close();
      await fresh.close();
    }
  }, 90_000);

  test("disables a member and keeps its identity while ending HTTP and realtime access", async ({ browser, page, identity }) => {
    const targetLogin = `disable_${Date.now().toString(36)}`;
    const targetPassword = "Disable-issued-password-2026";
    await login(page, identity.admin);
    await createMemberFromUi(page, targetLogin, targetPassword);

    const first = await newAuthenticatedPage(browser, { login: targetLogin, password: targetPassword });
    const second = await newAuthenticatedPage(browser, { login: targetLogin, password: targetPassword });
    try {
      await expect(first.page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      await expect(second.page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      await expect(first.page.getByRole("status")).toContainText("подключено");
      await expect(second.page.getByRole("status")).toContainText("подключено");

      const row = page.getByRole("listitem").filter({ hasText: targetLogin });
      await row.getByRole("button", { name: "Отключить" }).click();
      await row.getByLabel("Подтверждаю отключение учётной записи и завершение всех входов").check();
      await row.getByRole("button", { name: "Подтвердить отключение" }).click();
      await expect(row.getByText("Отключён", { exact: true })).toBeVisible();
      await expect(row.getByRole("status")).toHaveText("Учётная запись отключена. Все прежние сеансы завершены.");
      await expect(first.page.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expect(second.page.getByRole("heading", { name: "Вход" })).toBeVisible();

      const token = await issueCsrf(page.context().request);
      const own = await page.context().request.get("/api/auth/me");
      const ownIdentity = await own.json() as { id: string };
      const ownDisable = await page.context().request.post(`/api/members/${ownIdentity.id}/disable`, {
        failOnStatusCode: false,
        headers: { origin: applicationOrigin, "x-csrf-token": token }
      });
      expect(ownDisable.status()).toBe(409);

      const ordinary = identity.employee;
      expect(ordinary).toBeTruthy();
      if (ordinary) {
        const ordinarySession = await newAuthenticatedPage(browser, ordinary);
        try {
          const ordinaryToken = await issueCsrf(ordinarySession.context.request);
          const forbidden = await ordinarySession.context.request.post(`/api/members/${ownIdentity.id}/disable`, {
            failOnStatusCode: false,
            headers: { origin: applicationOrigin, "x-csrf-token": ordinaryToken }
          });
          expect(forbidden.status()).toBe(403);
        } finally {
          await ordinarySession.context.close();
        }
      }

      const staleFirst = await first.context.request.get("/api/auth/me", { failOnStatusCode: false });
      const staleSecond = await second.context.request.get("/api/auth/me", { failOnStatusCode: false });
      expect(staleFirst.status()).toBe(401);
      expect(staleSecond.status()).toBe(401);
      expect((await staleFirst.text())).not.toMatch(/password_hash|passwordHash/iu);

      const fresh = await browser.newPage();
      try {
        await fresh.goto("/");
        await fresh.getByLabel("Логин").fill(targetLogin);
        await fresh.getByLabel("Пароль").fill(targetPassword);
        await fresh.getByRole("button", { name: "Войти" }).click();
        await expect(fresh.getByRole("alert")).toContainText("Неверный логин или пароль");
      } finally {
        await fresh.close();
      }

      const repeatedToken = await issueCsrf(page.context().request);
      const repeatedDisable = await page.context().request.post(`/api/members/${(await row.getAttribute("data-member-id")) ?? ""}/disable`, {
        failOnStatusCode: false,
        headers: { origin: applicationOrigin, "x-csrf-token": repeatedToken }
      });
      expect(repeatedDisable.status()).toBe(204);
    } finally {
      await first.context.close();
      await second.context.close();
    }
  }, 90_000);

  test("rejects a reset-revoked browser cookie after app and database restart @session-after-restart", async ({ browser }) => {
    const stale = await browser.newContext({ storageState: storageStatePath });
    try {
      const page = await stale.newPage();
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expect(page.getByText("Организация", { exact: true })).toHaveCount(0);
      const response = await stale.request.get("/api/auth/me", { failOnStatusCode: false });
      expect(response.status()).toBe(401);
      expect(await response.text()).not.toMatch(/password_hash|passwordHash/iu);
    } finally {
      await stale.close();
    }
  });
});
