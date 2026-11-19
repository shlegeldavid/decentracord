import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationOrigin, expect, openSettingsSection, test, type TestIdentity } from "./fixtures.js";
import type { Page } from "@playwright/test";

// Валидный PNG 1×1: сигнатура, заголовок IHDR и данные IDAT с верными CRC.
const logoBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let logoDirectory = "";
let logoFile = "";

function logoBlock(page: Page) {
  return page.locator(".organization-logo-block");
}

async function submitLogin(page: Page, credentials: { login: string; password: string }): Promise<void> {
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
}

async function loginAsAdmin(page: Page, identity: TestIdentity): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await submitLogin(page, identity.admin);
  await expect(page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Закрыть настройки", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Настройки" })).toHaveCount(0);
}

async function uploadLogoFile(page: Page): Promise<void> {
  await logoBlock(page).locator('input[type="file"]').setInputFiles(logoFile);
  await expect(page.getByText("Логотип загружен.", { exact: true })).toBeVisible();
}

test.beforeAll(() => {
  logoDirectory = mkdtempSync(join(tmpdir(), "decentracord-organization-logo-"));
  logoFile = join(logoDirectory, "logo.png");
  writeFileSync(logoFile, Buffer.from(logoBase64, "base64"));
});

// Логотип — общее состояние установки, поэтому после проверок он удаляется:
// иначе следующие наборы в группе увидят чужую картинку.
test.afterAll(async ({ browser, identity }) => {
  const context = await browser.newContext();
  try {
    const request = context.request;
    const csrfResponse = await request.get("/api/auth/csrf");
    expect(csrfResponse.status()).toBe(200);
    const csrfPayload = await csrfResponse.json() as { csrfToken?: unknown };
    expect(typeof csrfPayload.csrfToken).toBe("string");
    const loginResponse = await request.post("/api/auth/login", {
      data: { login: identity.admin.login, password: identity.admin.password },
      failOnStatusCode: false,
      headers: {
        origin: applicationOrigin,
        "x-csrf-token": csrfPayload.csrfToken as string
      }
    });
    expect(loginResponse.status()).toBe(200);
    const loginPayload = await loginResponse.json() as { csrfToken?: unknown };
    expect(typeof loginPayload.csrfToken).toBe("string");
    const removal = await request.delete("/api/organization/logo", {
      failOnStatusCode: false,
      headers: {
        origin: applicationOrigin,
        "x-csrf-token": loginPayload.csrfToken as string
      }
    });
    expect(removal.status()).toBe(204);
  } finally {
    await context.close();
    if (logoDirectory) rmSync(logoDirectory, { recursive: true, force: true });
  }
});

test.describe("organization logo", () => {
  test("administrator uploads a PNG logo, sees it in the header and removes it", async ({ page, identity }) => {
    await loginAsAdmin(page, identity);
    await openSettingsSection(page, "Организация");

    const block = logoBlock(page);
    await expect(block).toBeVisible();
    await expect(block.getByText("Логотип не загружен.", { exact: true })).toBeVisible();
    await expect(block.locator(".organization-logo-preview")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Удалить логотип" }).within(block)).toBeDisabled();

    await uploadLogoFile(page);
    await expect(block.locator(".organization-logo-preview")).toBeVisible();

    // В шапке рабочего места вместо значка появляется логотип.
    await closeSettings(page);
    await expect(page.locator(".app-header-logo")).toBeVisible();
    await expect(page.locator(".app-header .brand-mark")).toHaveCount(0);

    // Удаление логотипа возвращает значок приложения.
    await openSettingsSection(page, "Организация");
    await page.getByRole("button", { name: "Удалить логотип" }).within(logoBlock(page)).click();
    const dialog = page.getByRole("dialog", { name: "Удалить логотип организации" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Подтверждаю удаление логотипа организации").check();
    await dialog.getByRole("button", { name: "Удалить логотип", exact: true }).click();
    await expect(page.getByText("Логотип удалён.", { exact: true })).toBeVisible();

    await closeSettings(page);
    await expect(page.locator(".app-header-logo")).toHaveCount(0);
    await expect(page.locator(".app-header .brand-mark")).toBeVisible();

    await openSettingsSection(page, "Организация");
    await expect(logoBlock(page).getByText("Логотип не загружен.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Удалить логотип" }).within(logoBlock(page))).toBeDisabled();
  });

  test("the sign-in screen shows no logo and requests none", async ({ browser, identity }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const logoRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/organization/logo")) logoRequests.push(request.url());
    });

    try {
      await loginAsAdmin(page, identity);
      await openSettingsSection(page, "Организация");
      await uploadLogoFile(page);
      await closeSettings(page);
      await expect(page.locator(".app-header-logo")).toBeVisible();

      // Логотип существует, но экран входа его не показывает и не запрашивает.
      logoRequests.length = 0;
      await page.getByRole("button", { name: "Выйти" }).click();
      await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expect(page.locator(".app-header-logo")).toHaveCount(0);
      await expect(page.getByText(identity.organizationName, { exact: true })).toHaveCount(0);
      expect(logoRequests).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
