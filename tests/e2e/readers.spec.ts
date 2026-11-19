import { randomUUID } from "node:crypto";
import { applicationOrigin, expect, test } from "./fixtures.js";
import type { Browser, BrowserContext, Page, Response } from "@playwright/test";

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

interface MessageSnapshot {
  id: string;
  seq: number;
  updatedSeq: number;
  content: string;
  deleted: boolean;
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

async function sendFromComposer(page: Page, content: string): Promise<MessageSnapshot> {
  const responseReady = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/messages"),
    { timeout: 10_000 }
  );
  await page.getByLabel("Сообщение").fill(content);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  const response = await responseReady;
  expect(response.status(), await response.text()).toBe(201);
  await expect(messageWithText(page, content)).toHaveCount(1);
  return await response.json() as MessageSnapshot;
}

function trackReadReceipts(page: Page, channelId: string): { current: () => number; count: () => number } {
  let seq = 0;
  let count = 0;
  const onResponse = (response: Response): void => {
    const request = response.request();
    if (request.method() !== "POST") return;
    if (new URL(response.url()).pathname !== `/api/channels/${channelId}/read`) return;
    count += 1;
    const body = request.postDataJSON() as { seq?: unknown };
    if (typeof body.seq === "number" && body.seq > seq) seq = body.seq;
  };
  page.on("response", onResponse);
  return { current: () => seq, count: () => count };
}

test.describe("message readers", () => {
  test("shows the readers of a message to its author only", async ({ browser, messagingSeed }) => {
    test.setTimeout(90_000);
    const author = await newAuthenticatedPage(browser, messagingSeed.manager);
    const reader = await newAuthenticatedPage(browser, messagingSeed.member);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const content = `readers-${randomUUID()}`;
    const readReceipts = trackReadReceipts(reader.page, channel.id);
    try {
      await selectChannel(reader.page, channel);
      await selectChannel(author.page, channel);
      // Читатель открыл канал и отметил его прочитанным раньше, чем появилось сообщение.
      await expect.poll(() => readReceipts.count()).toBeGreaterThan(0);

      const sent = await sendFromComposer(author.page, content);
      await expect.poll(() => readReceipts.current()).toBeGreaterThanOrEqual(sent.seq);

      // Своё сообщение: в меню есть пункт «Кто прочитал».
      const ownArticle = messageWithText(author.page, content);
      await expect(ownArticle).toHaveCount(1);
      await ownArticle.dispatchEvent("contextmenu", { button: 2, clientX: 320, clientY: 320 });
      const ownMenu = author.page.getByRole("menu", { name: "Действия с сообщением" });
      await expect(ownMenu).toBeVisible();
      const readersItem = author.page
        .getByRole("menuitem", { name: "Кто прочитал" })
        .within(author.page.locator(".context-menu"));
      await expect(readersItem).toBeVisible();
      await readersItem.click();

      const dialog = author.page.getByRole("dialog", { name: "Кто прочитал сообщение" });
      await expect(dialog).toBeVisible();
      const dialogScope = author.page.locator(".readers-modal");
      await expect(
        author.page.getByText(messagingSeed.member.login, { exact: true }).within(dialogScope)
      ).toHaveCount(1);
      const readerTime = author.page.locator(".reader-time").within(dialogScope);
      await expect(readerTime).toHaveCount(1);
      await expect(readerTime).toHaveText(/^\d{2}:\d{2}$/u);
      await expect(readerTime).toHaveAttribute("title", /^\d{2}\.\d{2}\.\d{4},\s\d{2}:\d{2}$/u);

      // Индикатора прочтений в ленте нет.
      await expect(author.page.locator(".message-row .readers-indicator")).toHaveCount(0);
      await expect(author.page.locator(".message-row .readers-list, .message-row .reader-row")).toHaveCount(0);

      // Чужое сообщение: пункта «Кто прочитал» в меню нет.
      await author.page.keyboard.press("Escape");
      await expect(author.page.getByRole("dialog", { name: "Кто прочитал сообщение" })).toHaveCount(0);
      const foreignArticle = messageWithText(reader.page, content);
      await expect(foreignArticle).toHaveCount(1);
      await foreignArticle.dispatchEvent("contextmenu", { button: 2, clientX: 320, clientY: 320 });
      const foreignMenu = reader.page.getByRole("menu", { name: "Действия с сообщением" });
      await expect(foreignMenu).toBeVisible();
      await expect(
        reader.page.getByRole("menuitem", { name: "Кто прочитал" }).within(reader.page.locator(".context-menu"))
      ).toHaveCount(0);
      await expect(reader.page.getByRole("dialog", { name: "Кто прочитал сообщение" })).toHaveCount(0);
    } finally {
      await Promise.all([closeContextBounded(author.context), closeContextBounded(reader.context)]);
    }
  });
});
