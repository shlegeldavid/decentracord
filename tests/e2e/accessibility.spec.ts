import AxeBuilder from "@axe-core/playwright";
import { expect, openSettingsSection, seedMessageHistory, test } from "./fixtures.js";
import type { Browser, Page } from "@playwright/test";

const accessibilityTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function login(page: Page, credentials: { login: string; password: string }): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход", exact: true })).toBeVisible();
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
}

async function expectAccessible(page: Page, screen: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(accessibilityTags).analyze();
  expect(results.violations, `Проверка доступности: ${screen}`).toEqual([]);
}

async function waitForSettingsContent(page: Page, section: string, requireExistingChannel = true): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Настройки" });
  if (section === "Организация") {
    await expect(dialog.getByRole("textbox", { name: "Название организации" })).toBeVisible();
  } else if (section === "Участники") {
    await expect(dialog.locator(".member-list[aria-busy='false'] [data-member-id]").first()).toBeVisible();
  } else if (section === "Роли") {
    await expect(dialog.locator(".role-list [data-role-id]").first()).toBeVisible();
  } else if (section === "Каналы") {
    await expect(dialog.locator(".channel-list")).toHaveAttribute("aria-busy", "false");
    if (requireExistingChannel) {
      await expect(dialog.locator(".channel-list [data-channel-id]").first()).toBeVisible();
      await expect(dialog.locator(".channel-details[aria-busy='false'] .override-grid")).toBeVisible();
    }
  } else if (section === "Права") {
    await expect(dialog.locator(".permission-matrix .permission-cell-value").first()).toBeVisible();
  } else if (section === "Настройки аккаунта") {
    await expect(dialog.locator(".account-profile strong")).toBeVisible();
  }
}

async function scanAdminSettings(page: Page): Promise<void> {
  for (const section of ["Организация", "Участники", "Роли", "Каналы", "Права"]) {
    await openSettingsSection(page, section);
    await waitForSettingsContent(page, section);
    await expectAccessible(page, `раздел «${section}»`);
  }
}

async function scanSignIn(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Вход", exact: true })).toBeVisible();
    await expectAccessible(page, "экран входа");
  } finally {
    await context.close();
  }
}

test("accessibility of the workspace, sign-in, settings and account screens", async ({ browser, page, identity }) => {
  await login(page, identity.admin);
  const channelName = `accessibility-${Date.now().toString(36)}`;
  await openSettingsSection(page, "Каналы");
  await waitForSettingsContent(page, "Каналы", false);
  const settingsDialog = page.getByRole("dialog", { name: "Настройки" });
  await settingsDialog.getByLabel("Название канала").fill(channelName);
  await settingsDialog.getByRole("button", { name: "Создать канал", exact: true }).click();
  await expect(page.getByText(`Канал «${channelName}» создан.`, { exact: true })).toBeVisible();
  const createdChannel = page.locator(".channel-list[data-scope='channels-page'] [data-channel-id]")
    .filter({ hasText: channelName });
  await expect(createdChannel).toBeVisible();
  const channelId = await createdChannel.getAttribute("data-channel-id");
  expect(channelId).toBeTruthy();
  const overrideGrid = settingsDialog.locator(".override-grid");
  const memberSend = overrideGrid.getByRole("combobox", { name: "SEND_MESSAGES для @everyone", exact: true });
  const administrator = overrideGrid.getByRole("combobox", { name: "ADMINISTRATOR для @everyone", exact: true });
  const saveOverrides = overrideGrid.getByRole("button", { name: "Сохранить переопределения", exact: true });
  await expect(administrator).toBeDisabled();
  await expect(memberSend).toHaveValue("unset");
  for (const state of ["allow", "deny", "unset"]) {
    await memberSend.selectOption(state);
    const write = page.waitForResponse((response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/channels/${channelId}/overrides`
    );
    await saveOverrides.click();
    expect((await write).status()).toBe(204);
    await expect(overrideGrid).toHaveAttribute("aria-busy", "false");
    await expect(memberSend).toHaveValue(state);
    await expect(saveOverrides).toBeDisabled();
  }
  const workspaceMessages = [
    "Accessibility sample message one",
    "Accessibility sample message two"
  ];
  await seedMessageHistory(channelId!, identity.admin.login, workspaceMessages);
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  const channel = page.locator(".channel-sidebar").getByRole("button", { name: channelName, exact: true });
  await expect(channel).toBeVisible();
  await channel.click();
  const messageFeed = page.locator(".message-feed");
  await expect(messageFeed).toBeVisible();
  await expect(messageFeed.locator("[data-message-id]")).toHaveCount(workspaceMessages.length);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotionAnimation = await messageFeed.evaluate((feed) => {
    const spinner = document.createElement("span");
    spinner.className = "feed-loading-spinner";
    feed.appendChild(spinner);
    const animationName = getComputedStyle(spinner).animationName;
    spinner.remove();
    return animationName;
  });
  expect(reducedMotionAnimation).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expectAccessible(page, "рабочее пространство");

  await scanSignIn(browser);
  await scanAdminSettings(page);

  await openSettingsSection(page, "Настройки аккаунта");
  await waitForSettingsContent(page, "Настройки аккаунта");
  await expectAccessible(page, "настройки аккаунта");

  const navigation = settingsDialog.getByRole("navigation", { name: "Разделы" });
  const account = navigation.getByRole("button", { name: "Настройки аккаунта", exact: true });
  const organization = navigation.getByRole("button", { name: "Организация", exact: true });
  await account.press("ArrowDown");
  await expect(organization).toBeFocused();
  await expect(organization).toHaveAttribute("aria-current", "page");
  await expect(settingsDialog.getByRole("heading", { name: "Организация", exact: true })).toBeVisible();
  await organization.press("ArrowUp");
  await expect(account).toBeFocused();
  await expect(account).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(settingsDialog).toHaveCount(0);
  await expect(page.locator(".app-header").getByRole("button", { name: "Настройки", exact: true })).toBeFocused();
});
