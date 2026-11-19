import {
  expect,
  test
} from "./fixtures.js";
import type { Browser, BrowserContext, Page } from "@playwright/test";

const applicationOrigin = new URL(
  process.env.TEST_ORIGIN ?? process.env.E2E_BASE_URL ?? "http://decentracord.test:3000"
).origin;

interface Credentials {
  login: string;
  password: string;
}

interface AuthenticatedSession {
  context: BrowserContext;
  page: Page;
  sentPackets: string[];
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
}

async function newAuthenticatedPage(browser: Browser, credentials: Credentials): Promise<AuthenticatedSession> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sentPackets = captureSocketPackets(page);
  try {
    await login(page, credentials);
    return { context, page, sentPackets };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function captureSocketPackets(page: Page): string[] {
  const sentPackets: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/realtime") && request.method() === "POST") {
      const packet = request.postData();
      if (packet) sentPackets.push(packet);
    }
  });
  page.on("websocket", (websocket) => {
    websocket.on("framesent", (frame) => {
      sentPackets.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString());
    });
  });
  return sentPackets;
}

async function issueCsrf(context: BrowserContext): Promise<string> {
  const response = await context.request.get(`${applicationOrigin}/api/auth/csrf`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { csrfToken?: unknown };
  expect(typeof body.csrfToken).toBe("string");
  return body.csrfToken as string;
}

function writeHeaders(csrfToken: string): Record<string, string> {
  return { origin: applicationOrigin, "x-csrf-token": csrfToken };
}

async function createChannel(context: BrowserContext, csrfToken: string, name: string): Promise<ChannelSummary> {
  const response = await context.request.post(`${applicationOrigin}/api/channels`, {
    data: { name },
    headers: writeHeaders(csrfToken),
    failOnStatusCode: false
  });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as ChannelSummary;
}

async function setChannelOverrides(
  context: BrowserContext,
  csrfToken: string,
  channelId: string,
  overrides: Array<Record<string, string | null>>
): Promise<void> {
  const response = await context.request.put(`${applicationOrigin}/api/channels/${channelId}/overrides`, {
    data: { overrides },
    headers: writeHeaders(csrfToken),
    failOnStatusCode: false
  });
  expect(response.status(), await response.text()).toBe(204);
}

function channelRow(page: Page, channelId: string) {
  return page.locator(`.channel-list[data-scope="workspace"] [data-channel-id="${channelId}"]`);
}

test.describe("channel visibility", () => {
  test("shares known closed metadata without exposing description, unread count, or socket subscription", async ({ browser, page, identity }) => {
    const suffix = Date.now().toString(36);
    const channelName = `e2e-known-${suffix}`;
    const adminSentPackets = captureSocketPackets(page);
    const deniedCredentials = identity.employee;
    expect(deniedCredentials).toBeTruthy();
    if (!deniedCredentials) return;

    await login(page, identity.admin);
    const adminContext = page.context();
    const adminCsrf = await issueCsrf(adminContext);
    const channel = await createChannel(adminContext, adminCsrf, channelName);
    await setChannelOverrides(adminContext, adminCsrf, channel.id, [
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "deny" }
    ]);

    let deniedSession: AuthenticatedSession | undefined;
    try {
      deniedSession = await newAuthenticatedPage(browser, deniedCredentials);
      const deniedRow = channelRow(deniedSession.page, channel.id);
      await expect(deniedRow).toHaveCount(0);

      const description = `Подробности видны только читателям ${suffix}`;
      const adminRow = channelRow(page, channel.id);
      await expect(adminRow).toBeVisible({ timeout: 15_000 });
      await adminRow.getByRole("button", { name: channel.name, exact: true }).click();
      await page.getByRole("button", { name: "Свойства канала", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Свойства канала" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Описание канала").fill(description);
      await dialog.getByRole("radio", { name: /Известен всем, но закрыт/u }).check();
      await dialog.getByRole("button", { name: "Сохранить свойства канала", exact: true }).click();
      await expect(dialog.getByText("Свойства канала сохранены.", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Отмена", exact: true }).click();

      await expect(deniedRow).toBeVisible();
      await expect(deniedRow.locator(".unread-badge")).toHaveCount(0);
      const deniedButton = deniedSession.page.locator(".channel-sidebar").getByRole("button", { name: channel.name, exact: true });
      await expect(deniedButton).toHaveCount(1);
      await deniedButton.hover();
      await deniedSession.page.waitForTimeout(500);
      // Проверяем именно закрытый канал: у его кнопки нет связи с подсказкой, а чужие описания в группе тестов не считаются.
      await expect(deniedButton).not.toHaveAttribute("aria-describedby", /channel-tooltip-/u);
      await expect(deniedSession.page.getByText(description, { exact: true })).toHaveCount(0);
      await deniedButton.click();
      await expect(deniedSession.page.locator(".channel-access-hint")).toHaveText("Нет доступа к этому каналу");
      await expect(deniedSession.page.getByRole("heading", { name: "Выберите канал", exact: true })).toBeVisible();

      await expect(adminRow.getByRole("button", { name: channel.name, exact: true })).toHaveCount(1);
      await expect(page.locator(".channel-topic")).toHaveText(description);
      await adminRow.getByRole("button", { name: channel.name, exact: true }).hover();
      // Подсказок на странице может быть несколько: проверяем ту, что относится к закрытому каналу.
      await expect(page.locator(".channel-tooltip").filter({ hasText: description })).toHaveText(description);
      await expect.poll(() => adminSentPackets.some((packet) =>
        packet.includes("channel:subscribe") && packet.includes(channel.id)
      )).toBe(true);
      await expect.poll(() => deniedSession!.sentPackets.some((packet) =>
        packet.includes("channel:subscribe") && packet.includes(channel.id)
      )).toBe(false);
    } finally {
      await deniedSession?.context.close();
    }
  });

  test("keeps known channel details after the app and database restart @session-after-restart", async ({ browser, identity }) => {
    const session = await newAuthenticatedPage(browser, identity.admin);
    try {
      const channelsResponse = await session.context.request.get(`${applicationOrigin}/api/channels`);
      expect(channelsResponse.status()).toBe(200);
      const body = await channelsResponse.json() as { channels?: Array<ChannelSummary & { description?: string | null; visibility?: string }> };
      const channel = body.channels?.find((entry) => entry.name.startsWith("e2e-known-"));
      expect(channel).toMatchObject({ visibility: "known" });
      if (!channel) throw new Error("Known channel is missing after restart");
      const detailResponse = await session.context.request.get(`${applicationOrigin}/api/channels/${channel.id}`);
      expect(detailResponse.status()).toBe(200);
      expect(await detailResponse.json()).toMatchObject({
        channel: { id: channel.id, visibility: "known", description: expect.stringContaining("Подробности видны только читателям") }
      });
    } finally {
      await session.context.close();
    }
  });
});
