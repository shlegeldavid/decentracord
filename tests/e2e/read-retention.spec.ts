import { expect, openSettingsSection, test, type TestIdentity } from "./fixtures.js";
import type { Page } from "@playwright/test";

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

function retentionBlock(page: Page) {
  return page.locator(".read-retention-block");
}

test.describe("read retention settings", () => {
  test("administrator sets the retention period and keeps it after a reload", async ({ page, identity }) => {
    await loginAsAdmin(page, identity);
    const initialRead = Promise.withResolvers<void>();
    await page.route("**/api/organization/read-retention", async (route) => {
      await initialRead.promise;
      await route.continue();
    }, { times: 1 });

    const block = retentionBlock(page);
    const foreverOption = page.getByRole("radio", { name: "Хранить бессрочно" }).within(block);
    const daysOption = page.getByRole("radio", { name: "Хранить заданное число дней" }).within(block);
    const daysField = page.getByRole("spinbutton", { name: "Срок хранения, дней" }).within(block);
    const saveButton = page.getByRole("button", { name: "Сохранить срок хранения" }).within(block);

    try {
      await openSettingsSection(page, "Организация");
      await expect(block).toBeVisible();
      await expect(foreverOption).toBeDisabled();
      await expect(daysOption).toBeDisabled();
    } finally {
      initialRead.resolve();
    }
    await expect(daysOption).toBeEnabled();

    // По умолчанию журнал хранится бессрочно, поля срока нет.
    await expect(foreverOption).toBeChecked();
    await expect(daysField).toHaveCount(0);

    // Переключение на вариант со сроком открывает поле со значением 90 дней.
    await daysOption.check();
    await expect(daysField).toBeVisible();
    await expect(daysField).toHaveValue("90");

    await daysField.fill("30");
    await saveButton.click();
    await expect(page.getByText("Срок хранения прочтений сохранён.", { exact: true }).within(block)).toBeVisible();

    // После перезагрузки страницы сохранённый срок остаётся.
    await page.reload();
    await openSettingsSection(page, "Организация");
    const reloadedBlock = retentionBlock(page);
    await expect(page.getByRole("radio", { name: "Хранить заданное число дней" }).within(reloadedBlock)).toBeChecked({ timeout: 15_000 });
    await expect(page.getByRole("spinbutton", { name: "Срок хранения, дней" }).within(reloadedBlock)).toHaveValue("30", { timeout: 15_000 });

    // Значение вне диапазона 1…3650 сохранить нельзя.
    await page.getByRole("spinbutton", { name: "Срок хранения, дней" }).within(reloadedBlock).fill("4000");
    await expect(page.getByRole("button", { name: "Сохранить срок хранения" }).within(reloadedBlock)).toBeDisabled();

    // Возврат к бессрочному хранению оставляет настройку в исходном состоянии.
    await page.getByRole("radio", { name: "Хранить бессрочно" }).within(reloadedBlock).check();
    await page.getByRole("button", { name: "Сохранить срок хранения" }).within(reloadedBlock).click();
    await expect(page.getByText("Срок хранения прочтений сохранён.", { exact: true }).within(reloadedBlock)).toBeVisible();
  });

  test("retention block is available to the administrator only", async ({ page, identity }) => {
    const employee = identity.employee;
    if (!employee) throw new Error("Employee fixture is unavailable in this test stage");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
    await submitLogin(page, employee);
    await expect(page.getByRole("heading", { name: identity.organizationName, exact: true })).toBeVisible();

    await openSettingsSection(page, "Настройки аккаунта");
    await expect(page.getByRole("navigation", { name: "Разделы" }).getByRole("button", { name: "Организация", exact: true })).toHaveCount(0);
    await expect(retentionBlock(page)).toHaveCount(0);
  });
});
