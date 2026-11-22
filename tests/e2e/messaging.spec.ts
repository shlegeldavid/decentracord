import { randomUUID } from "node:crypto";
import {
  applicationOrigin,
  captureExternalRequests,
  expect,
  seedMessageHistory,
  test
} from "./fixtures.js";
import type { Browser, BrowserContext, Page, Response, Route } from "@playwright/test";

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

interface CatchUpSnapshot {
  status: number;
  page: { messages: MessageSnapshot[]; cursor: number; hasMore: boolean };
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

function readResponses(page: Page, channelId: string, count: number): Promise<number[]> {
  return new Promise((resolve) => {
    const statuses: number[] = [];
    const onResponse = (response: Response): void => {
      if (response.request().method() !== "POST" || new URL(response.url()).pathname !== `/api/channels/${channelId}/read`) return;
      statuses.push(response.status());
      if (statuses.length >= count) {
        page.off("response", onResponse);
        resolve(statuses);
      }
    };
    page.on("response", onResponse);
  });
}

async function selectChannelAndSettleHistory(page: Page, channel: Pick<ChannelSummary, "id" | "name">): Promise<void> {
  const historyReady = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" &&
      url.pathname === `/api/channels/${channel.id}/messages` &&
      !url.searchParams.has("after");
  });
  const readStatusesReady = readResponses(page, channel.id, 2);
  await selectChannel(page, channel);
  const [history, readStatuses] = await Promise.all([
    historyReady,
    readStatusesReady
  ]);
  expect(history.status()).toBe(200);
  expect(readStatuses).toEqual([204, 204]);
}

async function issueCsrf(context: BrowserContext): Promise<string> {
  const response = await context.request.get(`${applicationOrigin}/api/auth/csrf`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { csrfToken?: unknown };
  expect(typeof body.csrfToken).toBe("string");
  return body.csrfToken as string;
}

async function sendFromComposer(page: Page, content: string, renderedText = content): Promise<MessageSnapshot> {
  const responseReady = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/messages"),
    { timeout: 10_000 }
  );
  await page.getByLabel("Сообщение").fill(content);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  const response = await responseReady;
  expect(response.status(), await response.text()).toBe(201);
  await expect(messageWithText(page, renderedText)).toHaveCount(1);
  return await response.json() as MessageSnapshot;
}

async function sendViaApi(
  context: BrowserContext,
  channelId: string,
  content: string,
  csrfToken: string
): Promise<MessageSnapshot> {
  const response = await context.request.post(
    `${applicationOrigin}/api/channels/${channelId}/messages`,
    {
      data: { content, clientRequestId: randomUUID() },
      failOnStatusCode: false,
      headers: { origin: applicationOrigin, "x-csrf-token": csrfToken }
    }
  );
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as MessageSnapshot;
}

async function editViaApi(
  context: BrowserContext,
  channelId: string,
  messageId: string,
  content: string,
  csrfToken: string
): Promise<MessageSnapshot> {
  const response = await context.request.patch(
    `${applicationOrigin}/api/channels/${channelId}/messages/${messageId}`,
    {
      data: { content },
      failOnStatusCode: false,
      headers: { origin: applicationOrigin, "x-csrf-token": csrfToken }
    }
  );
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as MessageSnapshot;
}

async function deleteViaApi(
  context: BrowserContext,
  channelId: string,
  messageId: string,
  csrfToken: string
): Promise<void> {
  const response = await context.request.delete(
    `${applicationOrigin}/api/channels/${channelId}/messages/${messageId}`,
    {
      failOnStatusCode: false,
      headers: { origin: applicationOrigin, "x-csrf-token": csrfToken }
    }
  );
  expect(response.status(), await response.text()).toBe(204);
}

async function currentHistoryCursor(context: BrowserContext, channelId: string): Promise<number> {
  const response = await context.request.get(
    `${applicationOrigin}/api/channels/${channelId}/messages?limit=50`
  );
  expect(response.status()).toBe(200);
  const body = await response.json() as { cursor?: unknown };
  expect(typeof body.cursor).toBe("number");
  return body.cursor as number;
}

async function holdCatchUpResponse(page: Page, channelId: string, cursor: number): Promise<{
  response: Promise<CatchUpSnapshot>;
  release: () => void;
  dispose: () => Promise<void>;
}> {
  const matches = (url: URL) =>
    url.pathname === `/api/channels/${channelId}/messages` && url.searchParams.get("after") === String(cursor);
  let resolveResponse!: (snapshot: CatchUpSnapshot) => void;
  let resolveCompleted!: () => void;
  let releaseResponse!: () => void;
  let heldRequest = false;
  const response = new Promise<CatchUpSnapshot>((resolve) => { resolveResponse = resolve; });
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  const held = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const handler = async (route: Route): Promise<void> => {
    if (heldRequest) {
      await route.continue();
      return;
    }
    heldRequest = true;
    const upstream = await route.fetch();
    const body = await upstream.body();
    resolveResponse({
      status: upstream.status(),
      page: JSON.parse(body.toString("utf8")) as CatchUpSnapshot["page"]
    });
    await held;
    await route.fulfill({ status: upstream.status(), headers: upstream.headers(), body });
    resolveCompleted();
  };
  await page.route(matches, handler);
  return {
    response,
    release: releaseResponse,
    dispose: async () => {
      releaseResponse();
      await Promise.race([completed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
      await page.unroute(matches, handler);
    }
  };
}

function messageWithText(page: Page, text: string) {
  return page.locator("[data-message-id]").filter({ hasText: text });
}

test.describe("channel messaging and reconnection", () => {
  test("follows live and queued messages and catches up once after reconnect", async ({ browser, messagingSeed }) => {
    test.setTimeout(90_000);
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const liveMessage = `live-delivery-${randomUUID()}`;
    const reconnectMessage = `reconnect-delivery-${randomUUID()}`;
    let documentNavigations = 0;
    let historyFetches = 0;
    try {
      await selectChannelAndSettleHistory(manager.page, channel);
      await selectChannel(member.page, channel);
      const feed = manager.page.locator(".message-feed");
      const distanceFromLatest = () => feed.evaluate((element) => {
        const container = element as HTMLElement;
        return container.scrollHeight - container.scrollTop - container.clientHeight;
      });
      const queuedRequestIds: Array<string | null> = [];
      const sentRequestIds: string[] = [];
      manager.page.on("request", (request) => {
        if (request.method() !== "POST" || new URL(request.url()).pathname !== `/api/channels/${channel.id}/messages`) return;
        const { clientRequestId } = request.postDataJSON() as { clientRequestId: string };
        sentRequestIds.push(clientRequestId);
      });

      await manager.context.setOffline(true);
      await expect(manager.page.locator(".connection-status")).toContainText("нет связи", { timeout: 15_000 });
      for (let index = 0; index < 3; index += 1) {
        const queuedMessage = `empty-channel-queue-${index}-${"x".repeat(1_800)}`;
        await manager.page.getByLabel("Сообщение").fill(queuedMessage);
        await manager.page.getByRole("button", { name: "Отправить", exact: true }).click();
        await expect(feed.locator(".message-pending")).toHaveCount(index + 1);
        const pending = feed.locator(".message-pending").filter({ hasText: queuedMessage });
        await expect(pending).toHaveAttribute("data-client-request-id", /.+/u);
        queuedRequestIds.push(await pending.getAttribute("data-client-request-id"));
      }
      await expect.poll(distanceFromLatest).toBeLessThanOrEqual(2);
      expect(sentRequestIds).toEqual([]);

      await sendFromComposer(member.page, reconnectMessage);
      await expect(messageWithText(manager.page, reconnectMessage)).toHaveCount(0, { timeout: 500 });
      await manager.context.setOffline(false);
      await expect(manager.page.locator(".connection-status")).toContainText("подключено", { timeout: 15_000 });
      await expect(feed.locator(".message-pending")).toHaveCount(0);
      await expect(feed.locator("[data-message-id]")).toHaveCount(4);
      expect(new Set(queuedRequestIds).size).toBe(3);
      expect(sentRequestIds).toEqual(queuedRequestIds);
      const recoveredMessage = messageWithText(manager.page, reconnectMessage);
      await expect(recoveredMessage).toHaveCount(1);
      await expect(recoveredMessage).toHaveAttribute("data-message-id", /.+/u);
      await expect.poll(distanceFromLatest).toBeLessThanOrEqual(2);
      await expect(feed).toHaveAttribute("aria-busy", "false");
      await manager.page.waitForLoadState("networkidle");

      const readReceipts: Array<{ seq: number; status: number }> = [];
      manager.page.on("response", (response) => {
        const request = response.request();
        if (request.method() !== "POST" || new URL(response.url()).pathname !== `/api/channels/${channel.id}/read`) return;
        const body = request.postDataJSON() as { seq?: unknown };
        if (typeof body.seq === "number") readReceipts.push({ seq: body.seq, status: response.status() });
      });

      manager.page.on("request", (request) => {
        if (request.isNavigationRequest() && request.resourceType() === "document") documentNavigations += 1;
        if (request.method() === "GET" && new URL(request.url()).pathname === `/api/channels/${channel.id}/messages`) {
          historyFetches += 1;
        }
      });
      const navigationCount = documentNavigations;
      const historyFetchCount = historyFetches;

      const liveMessageData = await sendFromComposer(member.page, liveMessage);
      await expect(messageWithText(manager.page, liveMessage)).toHaveCount(1);
      expect(documentNavigations).toBe(navigationCount);
      expect(historyFetches).toBe(historyFetchCount);
      await expect.poll(() => readReceipts.some((receipt) => receipt.seq >= liveMessageData.seq && receipt.status === 204)).toBe(true);
      await expect(channelRow(manager.page, channel.id).locator(".unread-badge")).toHaveCount(0);

      const memberCsrfToken = await issueCsrf(member.context);
      for (let index = 0; index < 24; index += 1) {
        const scrollMessage = `scroll-fill-${index}-${randomUUID()}`;
        await sendViaApi(member.context, channel.id, scrollMessage, memberCsrfToken);
        await expect(messageWithText(manager.page, scrollMessage)).toHaveCount(1);
      }
      await expect.poll(distanceFromLatest).toBeLessThanOrEqual(2);
      await expect(channelRow(manager.page, channel.id).locator(".unread-badge")).toHaveCount(0);

      await sendFromComposer(manager.page, `own-at-latest-${randomUUID()}`);
      await expect.poll(distanceFromLatest).toBeLessThanOrEqual(2);

      const partialScrollTop = await feed.evaluate((element) => {
        const container = element as HTMLElement;
        container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight - 120);
        return container.scrollTop;
      });
      expect(partialScrollTop).toBeGreaterThan(0);
      const incomingWhileReading = `incoming-while-reading-${randomUUID()}`;
      await sendFromComposer(member.page, incomingWhileReading);
      await expect(messageWithText(manager.page, incomingWhileReading)).toHaveCount(1);
      await expect.poll(() => feed.evaluate((element) => (element as HTMLElement).scrollTop)).toBe(partialScrollTop);

      await feed.evaluate((element) => { (element as HTMLElement).scrollTop = 0; });
      await expect.poll(() => feed.evaluate((element) => (element as HTMLElement).scrollTop)).toBe(0);
      const incomingAtTop = `incoming-at-top-${randomUUID()}`;
      await sendFromComposer(member.page, incomingAtTop);
      await expect(messageWithText(manager.page, incomingAtTop)).toHaveCount(1);
      await expect.poll(() => feed.evaluate((element) => (element as HTMLElement).scrollTop)).toBe(0);
      const jumpToLatest = manager.page.getByRole("button", { name: "К последним сообщениям" });
      await expect(jumpToLatest).toBeVisible();
      await jumpToLatest.click();
      await expect.poll(distanceFromLatest).toBeLessThanOrEqual(2);

      await manager.page.reload();
      await expect(manager.page.locator(".app-shell")).toBeVisible();
      await expect(channelRow(manager.page, channel.id).locator(".unread-badge")).toHaveCount(0);
      await expect(channelRow(manager.page, channel.id)).toBeVisible();
      await selectChannelAndSettleHistory(manager.page, channel);
    } finally {
      await Promise.all([closeContextBounded(manager.context), closeContextBounded(member.context)]);
    }
  });

  test("shows a visible clipboard error and lets the user retry", async ({ browser, messagingSeed }) => {
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const content = `clipboard-error-${randomUUID()}`;
    try {
      await selectChannelAndSettleHistory(manager.page, channel);
      await sendFromComposer(manager.page, content);
      await manager.page.setViewportSize({ width: 375, height: 667 });
      const message = messageWithText(manager.page, content);
      await message.dispatchEvent("contextmenu", { button: 2, clientX: 365, clientY: 655 });
      const contextMenu = manager.page.getByRole("menu", { name: "Действия с сообщением" });
      await expect(contextMenu).toBeVisible();
      const copyItem = manager.page.getByRole("menuitem", { name: "Копировать текст" });
      await expect(copyItem).toBeVisible();
      await manager.page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) }
        });
      });
      await copyItem.click();

      await expect(manager.page.getByText("Не удалось скопировать. Проверьте разрешение буфера обмена.", { exact: true }))
        .toBeVisible();
      await expect.poll(() => contextMenu.evaluate((menu) => menu.getBoundingClientRect().bottom)).toBeLessThanOrEqual(667);
      const retryCopy = manager.page.getByRole("menuitem", { name: "Повторить копирование" });
      await expect(retryCopy).toBeVisible();
      await manager.page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.resolve() }
        });
      });
      await retryCopy.click();
      await expect(manager.page.getByRole("menu")).toBeHidden();
      await expect(manager.page.locator("p.visually-hidden[aria-live='polite']"))
        .toHaveText("Текст сообщения скопирован");
    } finally {
      await closeContextBounded(manager.context);
    }
  });

  test("does not regress or resurrect messages when catch-up responses arrive late", async ({ browser, messagingSeed }) => {
    test.setTimeout(90_000);
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    let heldEdit: Awaited<ReturnType<typeof holdCatchUpResponse>> | undefined;
    let heldDelete: Awaited<ReturnType<typeof holdCatchUpResponse>> | undefined;
    try {
      await selectChannelAndSettleHistory(manager.page, channel);
      await selectChannel(member.page, channel);

      const csrfToken = await issueCsrf(member.context);
      const seedReadReceipts: Array<{ seq: number; status: number }> = [];
      const onSeedRead = (response: Response): void => {
        const request = response.request();
        if (request.method() !== "POST" || new URL(request.url()).pathname !== `/api/channels/${channel.id}/read`) return;
        const body = request.postDataJSON() as { seq?: unknown };
        if (typeof body.seq === "number") seedReadReceipts.push({ seq: body.seq, status: response.status() });
      };
      manager.page.on("response", onSeedRead);
      const message = await sendViaApi(member.context, channel.id, `race-seed-${randomUUID()}`, csrfToken);
      await expect(manager.page.locator(`[data-message-id="${message.id}"]`)).toHaveCount(1);
      await expect.poll(() => seedReadReceipts.some((receipt) => receipt.seq >= message.seq && receipt.status === 204)).toBe(true);
      manager.page.off("response", onSeedRead);
      const editBaseCursor = await currentHistoryCursor(manager.context, channel.id);

      await manager.context.setOffline(true);
      await expect(manager.page.locator(".connection-status")).toContainText("нет связи", { timeout: 15_000 });
      const staleEdit = await editViaApi(member.context, channel.id, message.id, "held stale edit", csrfToken);
      heldEdit = await holdCatchUpResponse(manager.page, channel.id, editBaseCursor);
      await manager.context.setOffline(false);
      await expect(manager.page.locator(".connection-status")).toContainText("подключено", { timeout: 15_000 });
      const staleSnapshot = await heldEdit.response;
      expect(staleSnapshot.status).toBe(200);
      expect(staleSnapshot.page.messages.find((entry) => entry.id === message.id)).toMatchObject({
        content: "held stale edit",
        deleted: false,
        updatedSeq: staleEdit.updatedSeq
      });

      const newestEdit = await editViaApi(member.context, channel.id, message.id, "realtime newest edit", csrfToken);
      await expect(messageWithText(manager.page, "realtime newest edit")).toHaveCount(1);
      await expect(messageWithText(manager.page, "held stale edit")).toHaveCount(0);
      const editCatchUpReady = manager.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "GET" &&
          url.pathname === `/api/channels/${channel.id}/messages` &&
          url.searchParams.get("after") === String(staleEdit.updatedSeq);
      }, { timeout: 15_000 });
      const editCatchUpRead = manager.page.waitForResponse((response) => {
        const request = response.request();
        if (request.method() !== "POST" || new URL(response.url()).pathname !== `/api/channels/${channel.id}/read`) return false;
        const body = request.postDataJSON() as { seq?: unknown };
        return typeof body.seq === "number" && body.seq >= message.seq;
      }, { timeout: 15_000 });
      heldEdit.release();
      const editCatchUp = await editCatchUpReady;
      expect(editCatchUp.status()).toBe(200);
      const editCatchUpPage = await editCatchUp.json() as { messages: MessageSnapshot[]; cursor: number };
      expect(editCatchUpPage.messages.find((entry) => entry.id === message.id)).toMatchObject({
        content: "realtime newest edit",
        deleted: false,
        updatedSeq: newestEdit.updatedSeq
      });
      await expect(messageWithText(manager.page, "realtime newest edit")).toHaveCount(1);
      await expect(messageWithText(manager.page, "held stale edit")).toHaveCount(0);
      expect((await editCatchUpRead).status()).toBe(204);
      await heldEdit.dispose();
      heldEdit = undefined;

      const deleteBaseCursor = await currentHistoryCursor(manager.context, channel.id);
      await manager.context.setOffline(true);
      await expect(manager.page.locator(".connection-status")).toContainText("нет связи", { timeout: 15_000 });
      const pendingEdit = await editViaApi(member.context, channel.id, message.id, "held before delete", csrfToken);
      heldDelete = await holdCatchUpResponse(manager.page, channel.id, deleteBaseCursor);
      await manager.context.setOffline(false);
      await expect(manager.page.locator(".connection-status")).toContainText("подключено", { timeout: 15_000 });
      const pendingSnapshot = await heldDelete.response;
      expect(pendingSnapshot.status).toBe(200);
      expect(pendingSnapshot.page.messages.find((entry) => entry.id === message.id)).toMatchObject({
        content: "held before delete",
        deleted: false,
        updatedSeq: pendingEdit.updatedSeq
      });

      const deleteCatchUpReady = manager.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "GET" &&
          url.pathname === `/api/channels/${channel.id}/messages` &&
          url.searchParams.get("after") === String(pendingEdit.updatedSeq);
      }, { timeout: 15_000 });
      await deleteViaApi(member.context, channel.id, message.id, csrfToken);
      const deletedMessage = manager.page.locator(`[data-message-id="${message.id}"]`);
      await expect(deletedMessage).toHaveClass(/message-row-deleted/u);
      await expect(deletedMessage).toContainText("Сообщение удалено");
      heldDelete.release();
      const deleteCatchUp = await deleteCatchUpReady;
      expect(deleteCatchUp.status()).toBe(200);
      const deleteCatchUpPage = await deleteCatchUp.json() as { messages: MessageSnapshot[]; cursor: number };
      expect(deleteCatchUpPage.messages.find((entry) => entry.id === message.id)).toMatchObject({
        deleted: true,
        updatedSeq: expect.any(Number)
      });
      await expect(deletedMessage).toHaveClass(/message-row-deleted/u);
      await expect(deletedMessage).toContainText("Сообщение удалено");
      await heldDelete.dispose();
      heldDelete = undefined;
    } finally {
      await heldEdit?.dispose();
      await heldDelete?.dispose();
      await Promise.all([closeContextBounded(manager.context), closeContextBounded(member.context)]);
    }
  });

  test("renders safe Markdown and lists only channel members", async ({ browser, identity, messagingSeed }) => {
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const content = [
      "**bold text** __underlined text__ ||spoiler text|| ~~deleted text~~ *italic text* `inline code`",
      "",
      "> quoted text",
      "",
      "| First | Second |",
      "| --- | --- |",
      "| cell one | cell two |",
      "",
      "- list item",
      "",
      "# Markdown heading",
      "",
      `@${messagingSeed.manager.login} [privacy link](https://tracker.invalid/collect) ![remote image](https://tracker.invalid/image.png)`,
      "",
      "<script>alert(1)</script>"
    ].join("\n");
    try {
      await selectChannel(member.page, channel);
      const memberPanel = member.page.locator(".member-panel");
      const roleGroups = memberPanel.locator(".channel-member-group");
      await expect(roleGroups.filter({ hasText: messagingSeed.manager.login }).getByRole("heading"))
        .toHaveText(/ — \d+$/);
      await expect(roleGroups.filter({ hasText: messagingSeed.member.login }).getByRole("heading"))
        .toHaveText(/ — \d+$/);
      await expect(memberPanel.locator(`[data-channel-member-id]`).filter({ hasText: messagingSeed.manager.login })).toBeVisible();
      await expect(memberPanel.locator(`[data-channel-member-id]`).filter({ hasText: messagingSeed.member.login })).toBeVisible();
      if (!identity.employee) throw new Error("Employee identity is unavailable before restart");
      await expect(memberPanel.locator("[data-channel-member-id]").filter({ hasText: identity.employee.login })).toHaveCount(0);

      const privacyContext = await browser.newContext({ baseURL: applicationOrigin });
      try {
        const unexpectedRequests = captureExternalRequests(privacyContext);
        const privacyPage = await privacyContext.newPage();
        await login(privacyPage, messagingSeed.member);
        await selectChannel(privacyPage, channel);
        await sendFromComposer(privacyPage, content, "bold text");
        const article = messageWithText(privacyPage, "bold text");
        await expect(article).toHaveCount(1);
        const body = article.locator(".message-body");
        await expect(body.locator("strong")).toHaveText("bold text");
        await expect(body.locator("u")).toHaveText("underlined text");
        await expect(body.locator(".spoiler")).toHaveText("spoiler text");
        await expect(body.locator("del")).toHaveText("deleted text");
        await expect(body.locator("em")).toHaveText("italic text");
        await expect(body.locator("code")).toHaveText("inline code");
        await expect(body.locator("blockquote")).toContainText("quoted text");
        await expect(body.locator("table")).toContainText("cell one");
        await expect(body.locator("ul")).toContainText("list item");
        await expect(body.locator("h1")).toHaveText("Markdown heading");
        await expect(body.locator(".mention")).toHaveText(`@${messagingSeed.manager.login}`);
        await expect(body.locator(".message-link")).toHaveText("privacy link");
        await expect(body.locator(".message-link a")).toHaveCount(0);
        await expect(body.locator("img, script")).toHaveCount(0);
        await privacyPage.waitForTimeout(500);
        expect(unexpectedRequests).toEqual([]);
      } finally {
        await closeContextBounded(privacyContext);
      }
    } finally {
      await closeContextBounded(member.context);
    }
  });

  test("allows message managers to remove another author's message", async ({ browser, messagingSeed }) => {
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const managerMessage = `manager-authored-${randomUUID()}`;
    const memberMessage = `member-authored-${randomUUID()}`;
    try {
      await selectChannel(manager.page, channel);
      await selectChannel(member.page, channel);

      await sendFromComposer(manager.page, managerMessage);
      const managerArticle = messageWithText(member.page, managerMessage);
      await expect(managerArticle).toHaveCount(1);
      await managerArticle.click({ button: "right" });
      const memberMenu = member.page.getByRole("menu", { name: "Действия с сообщением" });
      await expect(memberMenu).toBeVisible();
      await expect(memberMenu.getByRole("menuitem", { name: "Удалить" })).toHaveCount(0);
      await member.page.keyboard.press("Escape");

      await sendFromComposer(member.page, memberMessage);
      const memberArticle = messageWithText(manager.page, memberMessage);
      await expect(memberArticle).toHaveCount(1);
      const messageId = await memberArticle.getAttribute("data-message-id");
      expect(messageId).toBeTruthy();
      const deleteResponse = manager.page.waitForResponse((response) =>
        response.request().method() === "DELETE" && response.url().endsWith(`/messages/${messageId}`)
      );
      await memberArticle.click();
      await expect(memberArticle.getByRole("button", { name: "Удалить" })).toHaveCount(0);
      await memberArticle.click({ button: "right" });
      await manager.page.getByRole("menuitem", { name: "Удалить", exact: true }).click();
      expect((await deleteResponse).status()).toBe(204);
      await expect(messageWithText(manager.page, memberMessage)).toHaveCount(0);
      await expect(messageWithText(member.page, memberMessage)).toHaveCount(0);
    } finally {
      await Promise.all([closeContextBounded(manager.context), closeContextBounded(member.context)]);
    }
  });

  test("paginates and groups history, then converges after reload", async ({ browser, messagingSeed }) => {
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const channel = { id: messagingSeed.channelId, name: messagingSeed.channelName };
    const browserErrors: string[] = [];
    try {
      manager.page.on("pageerror", (error) => browserErrors.push(error.message));
      const historyContents = Array.from(
        { length: 55 },
        (_, index) => `history-item-${index.toString().padStart(2, "0")}`
      );
      await seedMessageHistory(channel.id, messagingSeed.manager.login, historyContents);

      const historyResponse = await manager.context.request.get(
        `${applicationOrigin}/api/channels/${channel.id}/messages?limit=50`
      );
      expect(historyResponse.status()).toBe(200);
      const history = await historyResponse.json() as { messages?: unknown[]; hasMore?: boolean };
      expect(history.messages).toHaveLength(50);
      expect(history.hasMore).toBe(true);

      const browserHistoryReady = manager.page.waitForResponse((response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/channels/${channel.id}/messages`,
        { timeout: 10_000 }
      );
      await selectChannel(manager.page, channel);
      const browserHistoryResponse = await browserHistoryReady;
      expect(browserHistoryResponse.status()).toBe(200);
      const browserHistory = await browserHistoryResponse.json() as {
        messages?: Array<{ content: string }>;
        hasMore?: boolean;
      };
      expect(browserHistory.messages).toHaveLength(50);
      expect(browserHistory.hasMore).toBe(true);
      expect(browserHistory.messages?.some((message) => message.content === "history-item-54")).toBe(true);
      await expect(
        messageWithText(manager.page, "history-item-54"),
        await manager.page.locator(".message-feed").innerText()
      ).toHaveCount(1);
      const feed = manager.page.locator(".message-feed");
      await expect(manager.page.locator("[data-message-id]")).toHaveCount(50);
      const earlierHistoryUrl = (url: URL): boolean =>
        url.pathname === `/api/channels/${channel.id}/messages` && url.searchParams.has("before");
      let releaseEarlierHistory!: () => void;
      let signalEarlierHistoryRequest!: () => void;
      const earlierHistoryResponseReleased = new Promise<void>((resolve) => {
        releaseEarlierHistory = resolve;
      });
      const earlierHistoryRequestIntercepted = new Promise<void>((resolve) => {
        signalEarlierHistoryRequest = resolve;
      });
      await manager.page.route(earlierHistoryUrl, async (route) => {
        signalEarlierHistoryRequest();
        await earlierHistoryResponseReleased;
        await route.continue();
      });
      try {
        const scrollBefore = await feed.evaluate((element) => {
          const container = element as HTMLElement;
          container.scrollTop = 0;
          return { scrollTop: container.scrollTop, scrollHeight: container.scrollHeight };
        });
        expect(scrollBefore.scrollTop).toBe(0);
        await earlierHistoryRequestIntercepted;
        await expect(manager.page.getByText("Загружаем более ранние сообщения…", { exact: true })).toBeVisible();
        releaseEarlierHistory();
        await expect(manager.page.locator("[data-message-id]")).toHaveCount(55);
        await expect(feed).toHaveAttribute("aria-busy", "false");
        const scrollAfter = await feed.evaluate((element) => {
          const container = element as HTMLElement;
          return { scrollTop: container.scrollTop, scrollHeight: container.scrollHeight };
        });
        const insertedPageHeight = scrollAfter.scrollHeight - scrollBefore.scrollHeight;
        expect(insertedPageHeight).toBeGreaterThan(0);
        expect(scrollAfter.scrollTop).toBeGreaterThanOrEqual(scrollBefore.scrollTop + insertedPageHeight - 3);
        expect(scrollAfter.scrollTop).toBeLessThanOrEqual(scrollBefore.scrollTop + insertedPageHeight + 3);
      } finally {
        releaseEarlierHistory();
        await manager.page.unroute(earlierHistoryUrl);
      }
      await expect(manager.page.locator(".day-divider")).toHaveCount(1);
      await expect(manager.page.locator(".message-author")).toHaveCount(1);
      await expect(manager.page.locator(".message-row-grouped")).toHaveCount(54);

      const originalId = await messageWithText(manager.page, "history-item-54").getAttribute("data-message-id");
      expect(originalId).toBeTruthy();
      const original = manager.page.locator(`[data-message-id="${originalId}"]`);
      const menu = manager.page.getByRole("menu", { name: "Действия с сообщением" });
      await original.dispatchEvent("pointerdown", {
        pointerId: 1, pointerType: "touch", clientX: 80, clientY: 80, bubbles: true
      });
      await expect(menu).toBeVisible();
      await manager.page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);

      const revisedContent = "history-item-54 revised after reload";
      const editResponse = manager.page.waitForResponse((response) =>
        response.request().method() === "PATCH" && response.url().endsWith(`/messages/${originalId}`)
      );
      await original.focus();
      await original.press("Shift+F10");
      await manager.page.getByRole("menuitem", { name: "Править", exact: true }).click();
      await original.getByRole("textbox", { name: "Изменить сообщение" }).fill(revisedContent);
      await original.getByRole("button", { name: "Сохранить" }).click();
      expect((await editResponse).status()).toBe(200);
      await expect(messageWithText(manager.page, revisedContent)).toBeFocused();
      await expect(manager.page.getByText("history-item-54", { exact: true })).toHaveCount(0);

      await manager.page.reload();
      await expect(manager.page.getByRole("heading", { name: "Вход" })).toHaveCount(0);
      await expect(manager.page.locator(".app-shell")).toBeVisible();
      await selectChannel(manager.page, channel);
      const convergedMessage = messageWithText(manager.page, revisedContent);
      await expect(convergedMessage).toHaveCount(1);
      expect(await convergedMessage.getAttribute("data-message-id")).toBe(originalId);
      await expect(manager.page.getByText("history-item-54", { exact: true })).toHaveCount(0);
      expect(browserErrors).toEqual([]);
    } finally {
      await closeContextBounded(manager.context);
    }
  });

  test("prepares a persistent channel and message for the restart check", async ({ page, identity }) => {
    const channelName = "e2e-messaging-restart";
    const messageContent = "e2e messaging survives restart";
    await login(page, identity.admin);
    const channelsResponse = await page.context().request.get(`${applicationOrigin}/api/channels`);
    expect(channelsResponse.status()).toBe(200);
    const channelsBody = await channelsResponse.json() as { channels?: ChannelSummary[] };
    let channel = channelsBody.channels?.find((entry) => entry.name === channelName);
    if (!channel) {
      const csrfToken = await issueCsrf(page.context());
      const created = await page.context().request.post(`${applicationOrigin}/api/channels`, {
        data: { name: channelName },
        headers: { origin: applicationOrigin, "x-csrf-token": csrfToken }
      });
      expect(created.status(), await created.text()).toBe(201);
      channel = await created.json() as ChannelSummary;
    }

    const historyResponse = await page.context().request.get(
      `${applicationOrigin}/api/channels/${channel.id}/messages?limit=50`
    );
    expect(historyResponse.status()).toBe(200);
    const history = await historyResponse.json() as { messages?: Array<{ content: string }> };
    if (!history.messages?.some((message) => message.content === messageContent)) {
      await sendViaApi(page.context(), channel.id, messageContent, await issueCsrf(page.context()));
    }
  });

  test("keeps the channel message available after the app and database restart @session-after-restart", async ({ browser, identity }) => {
    const storageStatePath = process.env.E2E_BOOTSTRAP_STORAGE_STATE_PATH ?? "/e2e-state/bootstrap-session.json";
    const context = await browser.newContext({
      baseURL: applicationOrigin,
      storageState: storageStatePath
    });
    try {
      const page = await context.newPage();
      await page.goto(`${applicationOrigin}/`);
      await expect(page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      await expect(page.locator(".connection-status")).toContainText("подключено");
      const channelName = "e2e-messaging-restart";
      const channelsResponse = await context.request.get(`${applicationOrigin}/api/channels`);
      expect(channelsResponse.status()).toBe(200);
      const channelsBody = await channelsResponse.json() as { channels?: ChannelSummary[] };
      const channel = channelsBody.channels?.find((entry) => entry.name === channelName);
      expect(channel).toBeTruthy();
      if (!channel) throw new Error("Persistent messaging channel is missing after restart");
      await selectChannel(page, channel);
      await expect(messageWithText(page, "e2e messaging survives restart")).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});
