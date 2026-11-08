import { test, expect, type TestIdentity } from "./fixtures.js";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";

const applicationOrigin = process.env.E2E_BASE_URL ?? "http://decentracord.test:3000";

function employeeIdentity(identity: TestIdentity) {
  if (!identity.employee) throw new Error("Employee fixture is unavailable in this test stage");
  return identity.employee;
}

async function submitLogin(page: Page, credentials: { login: string; password: string }): Promise<void> {
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
}

async function csrfToken(request: APIRequestContext): Promise<string> {
  const response = await request.get("/api/auth/csrf");
  expect(response.status()).toBe(200);
  const payload = await response.json() as { csrfToken?: unknown };
  expect(typeof payload.csrfToken).toBe("string");
  return payload.csrfToken as string;
}

async function patchOrganization(
  request: APIRequestContext,
  name: unknown,
  token: string
) {
  return request.patch("/api/organization", {
    data: name === undefined ? {} : { name },
    failOnStatusCode: false,
    headers: { origin: applicationOrigin, "x-csrf-token": token }
  });
}

async function loginAsAdmin(page: Page, identity: TestIdentity): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await submitLogin(page, identity.admin);
  await expect(page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
}

async function newPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test.describe("organization administration", () => {
  test("administrator saves a Unicode name that persists and renders as plain text", async ({
    browser,
    page,
    identity
  }) => {
    const submittedName = '<img src=x onerror="window.__organizationXss=1">  Тестовая организация  ';
    const savedName = submittedName.trim();

    await loginAsAdmin(page, identity);
    await page.getByRole("button", { name: "Настройки организации" }).click();
    const nameInput = page.getByRole("textbox", { name: "Название организации" });
    await expect(nameInput).toHaveValue(identity.organizationName);
    await nameInput.fill(submittedName);
    await page.getByRole("button", { name: "Сохранить" }).click();
    await expect(page.getByText("Название сохранено.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: savedName })).toBeVisible();
    await expect(page.locator("img[src='x']")).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { __organizationXss?: number }).__organizationXss)).toBeUndefined();

    await page.reload();
    await expect(page.getByRole("heading", { name: savedName })).toBeVisible();

    const fresh = await newPage(browser);
    try {
      await fresh.page.goto("/");
      await submitLogin(fresh.page, identity.admin);
      await expect(fresh.page.getByRole("heading", { name: savedName })).toBeVisible();
      await fresh.page.getByRole("button", { name: "Настройки организации" }).click();
      await fresh.page.getByRole("textbox", { name: "Название организации" }).fill(identity.organizationName);
      await fresh.page.getByRole("button", { name: "Сохранить" }).click();
      await expect(fresh.page.getByText("Название сохранено.", { exact: true })).toBeVisible();
    } finally {
      await fresh.context.close();
    }
  });

  test("organization writes validate the name and require administrator access", async ({
    browser,
    page,
    request,
    identity
  }) => {
    const guestToken = await csrfToken(request);
    const guestResponse = await patchOrganization(request, "Новое название", guestToken);
    expect(guestResponse.status()).toBe(401);

    await loginAsAdmin(page, identity);
    const adminRequest = page.context().request;
    const adminToken = await csrfToken(adminRequest);
    expect((await patchOrganization(adminRequest, "   ", adminToken)).status()).toBe(400);
    expect((await patchOrganization(adminRequest, "😀".repeat(101), adminToken)).status()).toBe(400);
    expect((await adminRequest.patch("/api/organization", {
      data: { name: "Допустимое название", admin: true },
      failOnStatusCode: false,
      headers: { origin: applicationOrigin, "x-csrf-token": adminToken }
    })).status()).toBe(400);

    const fresh = await newPage(browser);
    try {
      await fresh.page.goto("/");
      const employee = employeeIdentity(identity);
      await submitLogin(fresh.page, employee);
      await expect(fresh.page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      await expect(fresh.page.getByRole("button", { name: "Настройки организации" })).toHaveCount(0);
      const employeeRequest = fresh.context.request;
      const employeeToken = await csrfToken(employeeRequest);
      expect((await patchOrganization(employeeRequest, "Подмена названия", employeeToken)).status()).toBe(403);
    } finally {
      await fresh.context.close();
    }
  });

  test("administrator creates a member whose issued password works immediately", async ({
    browser,
    page,
    identity
  }) => {
    const memberLogin = `created_${Date.now().toString(36)}`;
    const memberPassword = "Member-issued-password-2026";
    await loginAsAdmin(page, identity);
    await page.getByRole("button", { name: "Участники" }).click();
    await expect(page.getByRole("heading", { name: "Участники" })).toBeVisible();
    await page.getByLabel("Логин").fill(memberLogin);
    await page.getByLabel("Пароль").fill(memberPassword);
    await page.getByRole("button", { name: "Создать участника" }).click();
    await expect(page.getByText("Участник создан. Пароль больше не отображается.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Пароль")).toHaveValue("");
    await expect(page.getByText(memberLogin, { exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(memberPassword);

    const fresh = await newPage(browser);
    try {
      await fresh.page.goto("/");
      await submitLogin(fresh.page, { login: memberLogin, password: memberPassword });
      await expect(fresh.page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      await expect(fresh.page.getByText(memberLogin, { exact: true })).toBeVisible();
      await expect(fresh.page.getByLabel("Новый пароль")).toHaveCount(0);
      await expect(fresh.page.getByRole("button", { name: "Участники" })).toHaveCount(0);
    } finally {
      await fresh.context.close();
    }
  });
});
