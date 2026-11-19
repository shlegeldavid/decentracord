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

interface OverrideInput {
  subject: "everyone" | "role" | "member";
  subjectId: string | null;
  permission: string;
  effect: "allow" | "deny" | "unset";
}

const sendableOverrides: OverrideInput[] = [
  { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
  { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "allow" }
];

const readOnlyOverrides: OverrideInput[] = [
  { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
  { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "deny" }
];

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

async function issueCsrf(context: BrowserContext): Promise<string> {
  const response = await context.request.get(`${applicationOrigin}/api/auth/csrf`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { csrfToken?: unknown };
  expect(typeof body.csrfToken).toBe("string");
  return body.csrfToken as string;
}

async function createChannelViaApi(
  context: BrowserContext,
  name: string,
  overrides: OverrideInput[]
): Promise<ChannelSummary> {
  const csrfToken = await issueCsrf(context);
  const response = await context.request.post(`${applicationOrigin}/api/channels`, {
    data: { name, overrides },
    failOnStatusCode: false,
    headers: { origin: applicationOrigin, "x-csrf-token": csrfToken }
  });
  const text = await response.text();
  expect(response.status(), text).toBe(201);
  return JSON.parse(text) as ChannelSummary;
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

async function openForwardDialog(page: Page, content: string) {
  await openContextMenu(page, content);
  const forwardItem = page.getByRole("menuitem", { name: "Переслать", exact: true })
    .within(page.locator(".context-menu"));
  await expect(forwardItem).toBeVisible();
  await forwardItem.click();
  const dialog = page.getByRole("dialog", { name: "Переслать сообщение" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("message forwarding", () => {
  test("opens the forward dialog from the message menu and lists only channels the participant can write to", async ({ browser, identity, messagingSeed }) => {
    test.setTimeout(120_000);
    // Каналы создаются до входа участника: список каналов участника сразу
    // содержит и канал-получатель, и канал только для чтения.
    const admin = await newAuthenticatedPage(browser, identity.admin);
    const suffix = randomUUID().slice(0, 8);
    const targetChannel = await createChannelViaApi(admin.context, `e2e-forward-target-${suffix}`, sendableOverrides);
    const readOnlyChannel = await createChannelViaApi(admin.context, `e2e-forward-readonly-${suffix}`, readOnlyOverrides);
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const content = `forward-dialog-${randomUUID()}`;
    try {
      await selectChannel(manager.page, channel);
      await sendFromComposer(manager.page, content);

      const dialog = await openForwardDialog(manager.page, content);
      // Превью показывает начало текста пересылаемого сообщения.
      await expect(dialog.locator(".forward-preview")).toContainText(content);
      // Список каналов-получателей содержит только каналы с правом отправки.
      await expect(dialog.getByRole("option", { name: targetChannel.name, exact: true })).toHaveCount(1);
      await expect(dialog.getByRole("option", { name: readOnlyChannel.name, exact: true })).toHaveCount(0);
      // Пока канал не выбран, кнопка «Переслать» недоступна.
      await expect(dialog.getByRole("button", { name: "Переслать", exact: true })).toBeDisabled();

      await manager.page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    } finally {
      await Promise.all([closeContextBounded(manager.context), closeContextBounded(admin.context)]);
    }
  });

  test("forwards a message to another channel, keeps the original in place and does not carry mentions over", async ({ browser, identity, messagingSeed }) => {
    test.setTimeout(120_000);
    const admin = await newAuthenticatedPage(browser, identity.admin);
    const suffix = randomUUID().slice(0, 8);
    const targetChannel = await createChannelViaApi(admin.context, `e2e-forward-target-${suffix}`, sendableOverrides);
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const content = `forward-body-${randomUUID()} @${messagingSeed.manager.login}`;
    try {
      await selectChannel(member.page, channel);
      await selectChannel(manager.page, channel);
      // Оригинал пишет участник, пересылает администратор: в пометке должен быть
      // автор оригинала, а не пересылающего.
      await sendFromComposer(member.page, content);
      await expect(messageWithText(manager.page, content)).toHaveCount(1);

      const dialog = await openForwardDialog(manager.page, content);
      const forwardResponse = manager.page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/forward"),
        { timeout: 10_000 }
      );
      await dialog.getByRole("option", { name: targetChannel.name, exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Переслать", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "Переслать", exact: true }).click();
      expect((await forwardResponse).status()).toBe(201);
      await expect(dialog).toHaveCount(0);

      // В целевом канале появляется копия с пометкой об авторе оригинала.
      await selectChannel(manager.page, targetChannel);
      const forwardedArticle = messageWithText(manager.page, content);
      await expect(forwardedArticle).toHaveCount(1);
      const block = forwardedArticle.locator(".forwarded-block");
      await expect(block).toHaveCount(1);
      await expect(block).toContainText(`Переслано от ${messagingSeed.member.login}`);
      // Упоминание в пересланном сообщении не подсвечивается.
      await expect(block.locator(".mention")).toHaveCount(0);
      // Автор пересланного сообщения — пересылающий.
      await expect(forwardedArticle.locator(".message-author")).toHaveText(messagingSeed.manager.login);

      // Оригинал остаётся в канале-источнике.
      await selectChannel(member.page, channel);
      await expect(messageWithText(member.page, content)).toHaveCount(1);
    } finally {
      await Promise.all([
        closeContextBounded(manager.context),
        closeContextBounded(member.context),
        closeContextBounded(admin.context)
      ]);
    }
  });

  test("jumps to the original message from the forwarded block", async ({ browser, identity, messagingSeed }) => {
    test.setTimeout(120_000);
    const admin = await newAuthenticatedPage(browser, identity.admin);
    const suffix = randomUUID().slice(0, 8);
    const targetChannel = await createChannelViaApi(admin.context, `e2e-forward-target-${suffix}`, sendableOverrides);
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const content = `forward-jump-${randomUUID()}`;
    try {
      await selectChannel(manager.page, channel);
      await sendFromComposer(manager.page, content);

      const dialog = await openForwardDialog(manager.page, content);
      const forwardResponse = manager.page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/forward"),
        { timeout: 10_000 }
      );
      await dialog.getByRole("option", { name: targetChannel.name, exact: true }).click();
      await dialog.getByRole("button", { name: "Переслать", exact: true }).click();
      expect((await forwardResponse).status()).toBe(201);

      await selectChannel(manager.page, targetChannel);
      const block = messageWithText(manager.page, content).locator(".forwarded-block");
      await expect(block).toHaveCount(1);
      const link = block.getByRole("button", { name: messagingSeed.manager.login, exact: true });
      await expect(link).toHaveCount(1);
      await link.click();

      // Переход открывает канал-источник и ставит фокус на оригинал.
      await expect(manager.page.getByRole("heading", { level: 2, name: channel.name })).toBeVisible();
      const original = messageWithText(manager.page, content);
      await expect(original).toHaveCount(1);
      await expect(original).toBeFocused();
    } finally {
      await Promise.all([closeContextBounded(manager.context), closeContextBounded(admin.context)]);
    }
  });
});
