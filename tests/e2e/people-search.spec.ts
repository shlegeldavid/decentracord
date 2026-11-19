import { applicationOrigin, expect, test } from "./fixtures.js";
import type { Browser, BrowserContext, Page } from "@playwright/test";

// Общий префикс логинов участников стенда: отличает их от служебных учётных
// записей проверки и от администратора организации.
const colleaguePrefix = "fixture_e2e_msg_ma";
const absentPrefix = "zzz_absent_participant";

async function login(page: Page, credentials: { login: string; password: string }): Promise<void> {
  await page.goto(`${applicationOrigin}/`);
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".connection-status")).toContainText("подключено");
}

async function newAuthenticatedPage(
  browser: Browser,
  credentials: { login: string; password: string }
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: applicationOrigin });
  const page = await context.newPage();
  try {
    await login(page, credentials);
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

test.describe("people search in the workspace header", () => {
  test("finds a colleague by login prefix and expands the participant card", async ({ browser, messagingSeed }) => {
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    try {
      const field = member.page.getByRole("combobox", { name: "Поиск людей" });
      await expect(field).toBeVisible();
      await field.fill(colleaguePrefix);

      const list = member.page.getByRole("listbox", { name: "Результаты поиска людей" });
      await expect(list).toBeVisible();
      const option = member.page.getByRole("option", { name: messagingSeed.manager.login }).within(list);
      await expect(option).toBeVisible();
      // Ищущий участник не попадает в собственную выдачу.
      await expect(
        member.page.getByRole("option", { name: messagingSeed.member.login }).within(list)
      ).toHaveCount(0);

      // В общей базе группы префикс совпадает у менеджеров нескольких стендов,
      // поэтому для клавиатурной части уточняем запрос до полного логина:
      // точное совпадение сервер отдаёт первым.
      await field.fill(messagingSeed.manager.login);
      await expect(list.getByRole("option").first()).toContainText(messagingSeed.manager.login);
      await field.press("ArrowDown");
      await expect(option).toHaveAttribute("aria-selected", "true");
      await field.press("Enter");

      const card = member.page.locator(".people-search-card");
      await expect(card).toBeVisible();
      await expect(member.page.getByText("Роли", { exact: true }).within(card)).toBeVisible();
      await expect(member.page.getByText("Общие каналы", { exact: true }).within(card)).toBeVisible();
      await expect(card).toContainText(messagingSeed.channelName);

      // Кнопка открывает форму создания личной переписки.
      const messageButton = member.page.getByRole("button", { name: "Написать сообщение" }).within(card);
      await expect(messageButton).not.toHaveAttribute("aria-disabled", "true");
      expect(await messageButton.getAttribute("disabled")).toBeNull();
      await field.press("Tab");
      await expect(messageButton).toBeFocused();
    } finally {
      await member.context.close();
    }
  });

  test("reports an empty result for a query that matches nobody", async ({ browser, messagingSeed }) => {
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    try {
      const field = member.page.getByRole("combobox", { name: "Поиск людей" });
      await field.fill(absentPrefix);

      const list = member.page.getByRole("listbox", { name: "Результаты поиска людей" });
      await expect(list).toBeVisible();
      await expect(member.page.getByText("Никого не нашли.", { exact: true }).within(list)).toBeVisible();
      await expect(
        member.page.getByText("Попробуйте другой запрос.", { exact: true }).within(list)
      ).toBeVisible();
      await expect(member.page.getByRole("option").within(list)).toHaveCount(0);
    } finally {
      await member.context.close();
    }
  });
});
