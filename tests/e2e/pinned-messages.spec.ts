import { randomUUID } from "node:crypto";
import { applicationOrigin, expect, test } from "./fixtures.js";
import type { Browser, BrowserContext, Page } from "@playwright/test";

interface Credentials {
  login: string;
  password: string;
}

interface AuthenticatedSession {
  context: BrowserContext;
  page: Page;
}

interface ChannelSummary {
  id: string;
  name: string;
}

async function login(page: Page, credentials: Credentials): Promise<void> {
  await page.goto(`${applicationOrigin}/`);
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".connection-status")).toContainText("подключено");
}

async function newAuthenticatedPage(browser: Browser, credentials: Credentials): Promise<AuthenticatedSession> {
  const context = await browser.newContext({ baseURL: applicationOrigin });
  const page = await context.newPage();
  try {
    await login(page, credentials);
    return { context, page };
  } catch (error) {
    await closeContextBounded(context);
    throw error;
  }
}

async function closeContextBounded(context: BrowserContext): Promise<void> {
  await Promise.race([
    context.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000))
  ]);
}

function channelRow(page: Page, channelId: string) {
  return page.locator(`.channel-list[data-scope="workspace"] [data-channel-id="${channelId}"]`);
}

async function selectChannel(page: Page, channel: Pick<ChannelSummary, "id" | "name">): Promise<void> {
  const row = channelRow(page, channel.id);
  await expect(row).toBeVisible();
  await row.locator(".channel-list-select").click();
  await expect(page.getByRole("heading", { level: 2, name: channel.name })).toBeVisible();
  await expect(page.locator(".message-feed")).toBeVisible();
}

function messageWithText(page: Page, text: string) {
  return page.locator("[data-message-id]").filter({ hasText: text });
}

async function sendFromComposer(page: Page, content: string): Promise<void> {
  const responseReady = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/messages"),
    { timeout: 10_000 }
  );
  await page.getByLabel("Сообщение").fill(content);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  const response = await responseReady;
  expect(response.status(), await response.text()).toBe(201);
  await expect(messageWithText(page, content)).toHaveCount(1);
}

async function openContextMenu(page: Page, content: string): Promise<void> {
  const article = messageWithText(page, content);
  await expect(article).toHaveCount(1);
  await article.dispatchEvent("contextmenu", { button: 2, clientX: 320, clientY: 320 });
  await expect(page.getByRole("menu", { name: "Действия с сообщением" })).toBeVisible();
}

async function openPinsPanel(page: Page, channel: Pick<ChannelSummary, "id" | "name">): Promise<void> {
  const trigger = page.getByRole("button", { name: channel.name, exact: true })
    .within(page.locator(".chat-pane-header"));
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Закреплённые сообщения" })).toBeVisible();
}

async function closePinsPanel(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Закреплённые сообщения" })).toHaveCount(0);
}

test.describe("pinned messages", () => {
  test("shows the empty state in a channel without pins", async ({ browser, messagingSeed }) => {
    test.setTimeout(90_000);
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    try {
      await selectChannel(manager.page, channel);
      await openPinsPanel(manager.page, channel);
      const dialog = manager.page.getByRole("dialog", { name: "Закреплённые сообщения" });
      await expect(dialog.getByText("Нет закреплённых", { exact: true })).toBeVisible();
      await expect(
        dialog.getByText("Закреплённые сообщения появятся здесь, когда их закрепят.", { exact: true })
      ).toBeVisible();
    } finally {
      await closeContextBounded(manager.context);
    }
  });

  test("pins a message from the context menu and shows it in the panel of the channel header", async ({ browser, messagingSeed }) => {
    test.setTimeout(90_000);
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const content = `pinned-${randomUUID()}`;
    try {
      await selectChannel(manager.page, channel);
      await sendFromComposer(manager.page, content);

      await openContextMenu(manager.page, content);
      const menu = manager.page.getByRole("menu", { name: "Действия с сообщением" });
      const pinItem = manager.page.getByRole("menuitem", { name: "Закрепить", exact: true })
        .within(manager.page.locator(".context-menu"));
      await expect(pinItem).toBeVisible();
      const pinResponse = manager.page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/pins"),
        { timeout: 10_000 }
      );
      await pinItem.click();
      expect((await pinResponse).status()).toBe(204);
      await expect(menu).toHaveCount(0);

      // Панель открывается кликом по названию канала в шапке.
      await openPinsPanel(manager.page, channel);
      const dialog = manager.page.getByRole("dialog", { name: "Закреплённые сообщения" });
      await expect(dialog.getByText(content, { exact: true })).toHaveCount(1);
      await expect(dialog.getByRole("button", { name: "Открепить", exact: true })).toHaveCount(1);
    } finally {
      await closeContextBounded(manager.context);
    }
  });

  test("offers the unpin action to the author of a pinned message and hides the pin action", async ({ browser, messagingSeed }) => {
    test.setTimeout(90_000);
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const content = `pinned-by-manager-${randomUUID()}`;
    try {
      await selectChannel(manager.page, channel);
      await selectChannel(member.page, channel);
      await sendFromComposer(member.page, content);
      await expect(messageWithText(manager.page, content)).toHaveCount(1);

      // Участник с правом управления закрепляет сообщение другого участника.
      await openContextMenu(manager.page, content);
      const managerPinItem = manager.page.getByRole("menuitem", { name: "Закрепить", exact: true })
        .within(manager.page.locator(".context-menu"));
      const managerPinResponse = manager.page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/pins"),
        { timeout: 10_000 }
      );
      await managerPinItem.click();
      expect((await managerPinResponse).status()).toBe(204);

      // Участник без права управления не видит пункта «Закрепить»…
      // …но видит «Открепить» для своего закреплённого сообщения. Состояние
      // закрепления приходит по событию сокета, поэтому пункт ждём опросом.
      await expect.poll(async () => {
        await openContextMenu(member.page, content);
        const menu = member.page.locator(".context-menu");
        const pinCount = await member.page.getByRole("menuitem", { name: "Закрепить", exact: true })
          .within(menu).count();
        const unpinCount = await member.page.getByRole("menuitem", { name: "Открепить", exact: true })
          .within(menu).count();
        await member.page.keyboard.press("Escape");
        return { pinCount, unpinCount };
      }, { timeout: 20_000, intervals: [250, 500, 1000] }).toEqual({ pinCount: 0, unpinCount: 1 });

      // В панели закреплённых автор сообщения тоже видит «Открепить».
      await openPinsPanel(member.page, channel);
      const dialog = member.page.getByRole("dialog", { name: "Закреплённые сообщения" });
      await expect(dialog.getByText(content, { exact: true })).toHaveCount(1);
      await expect(dialog.getByRole("button", { name: "Открепить", exact: true })).toHaveCount(1);
    } finally {
      await Promise.all([closeContextBounded(manager.context), closeContextBounded(member.context)]);
    }
  });

  test("removes the pinned message from the panel when the message is deleted", async ({ browser, messagingSeed }) => {
    test.setTimeout(90_000);
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const content = `pinned-and-deleted-${randomUUID()}`;
    try {
      await selectChannel(manager.page, channel);
      await sendFromComposer(manager.page, content);

      await openContextMenu(manager.page, content);
      const pinItem = manager.page.getByRole("menuitem", { name: "Закрепить", exact: true })
        .within(manager.page.locator(".context-menu"));
      const pinResponse = manager.page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/pins"),
        { timeout: 10_000 }
      );
      await pinItem.click();
      expect((await pinResponse).status()).toBe(204);

      await openPinsPanel(manager.page, channel);
      const dialog = manager.page.getByRole("dialog", { name: "Закреплённые сообщения" });
      await expect(dialog.getByText(content, { exact: true })).toHaveCount(1);
      await closePinsPanel(manager.page);

      await openContextMenu(manager.page, content);
      const deleteItem = manager.page.getByRole("menuitem", { name: "Удалить", exact: true })
        .within(manager.page.locator(".context-menu"));
      const deleteResponse = manager.page.waitForResponse((response) =>
        response.request().method() === "DELETE" && new URL(response.url()).pathname.includes("/messages/"),
        { timeout: 10_000 }
      );
      await deleteItem.click();
      expect((await deleteResponse).status()).toBe(204);

      await openPinsPanel(manager.page, channel);
      await expect(manager.page.getByRole("dialog", { name: "Закреплённые сообщения" })
        .getByText(content, { exact: true })).toHaveCount(0);
    } finally {
      await closeContextBounded(manager.context);
    }
  });
});
