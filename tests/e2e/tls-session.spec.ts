import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { io, type Socket } from "socket.io-client";
import { test, expect } from "./fixtures.js";
import type { Browser, BrowserContext, Page, WebSocket } from "@playwright/test";

const testOrigin = process.env.TEST_ORIGIN ?? "https://proxy:443";
const applicationOrigin = new URL(testOrigin).origin;

interface AuthenticatedClient {
  context: BrowserContext;
  page: Page;
  websocket: WebSocket;
}

interface BrowserCredentials {
  login: string;
  password: string;
}

async function login(page: Page, credentials: BrowserCredentials): Promise<void> {
  await page.goto(`${applicationOrigin}/`);
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
}

function isRealtimeWebSocket(websocket: WebSocket): boolean {
  const url = new URL(websocket.url());
  return url.pathname === "/socket.io/" && url.searchParams.get("transport") === "websocket";
}

async function authenticatedClient(browser: Browser, credentials: BrowserCredentials): Promise<AuthenticatedClient> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const websocketPromise = page.waitForEvent("websocket", { predicate: isRealtimeWebSocket, timeout: 20_000 });
  await login(page, credentials);
  await expect(page.getByRole("button", { name: "Настройки аккаунта" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("подключено", { timeout: 15_000 });
  return { context, page, websocket: await websocketPromise };
}

async function sessionCookie(context: BrowserContext): Promise<{ value: string; header: string }> {
  const cookie = (await context.cookies(applicationOrigin)).find(({ name }) => name === "__Host-decentracord.sid");
  expect(cookie).toBeTruthy();
  expect(cookie?.secure).toBe(true);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  return { value: cookie!.value, header: `${cookie!.name}=${cookie!.value}` };
}

async function expectRevokedHttpSession(context: BrowserContext, cookieHeader: string): Promise<void> {
  const response = await context.request.get(`${applicationOrigin}/api/auth/me`, {
    failOnStatusCode: false,
    headers: { cookie: cookieHeader }
  });
  expect(response.status()).toBe(401);
  expect(await response.text()).not.toMatch(/Организация|password_hash/iu);
}

async function socketCanReconnect(cookieHeader: string): Promise<boolean> {
  const socket: Socket = io(`${applicationOrigin}/realtime`, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 7_000,
    transports: ["polling", "websocket"],
    extraHeaders: { cookie: cookieHeader, origin: applicationOrigin }
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), 8_000);
    const finish = (connected: boolean): void => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("connect_error", () => finish(false));
    socket.connect();
  });
}

async function rejectedByUntrustedCa(): Promise<boolean> {
  const caPath = process.env.TEST_UNTRUSTED_CA_FILE;
  if (!caPath) throw new Error("TLS negative-test CA is missing");
  const ca = readFileSync(caPath);

  return new Promise((resolve) => {
    const request = httpsRequest(`${applicationOrigin}/healthz`, {
      ca,
      rejectUnauthorized: true,
      timeout: 8_000
    }, (response) => {
      response.resume();
      resolve(false);
    });
    request.once("error", () => resolve(true));
    request.once("timeout", () => request.destroy(new Error("TLS test request timed out")));
    request.end();
  });
}

async function createMember(page: Page, loginValue: string, password: string): Promise<void> {
  await page.getByRole("button", { name: "Участники" }).click();
  await expect(page.getByRole("heading", { name: "Участники" })).toBeVisible();
  await page.getByLabel("Логин").fill(loginValue);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Создать участника" }).click();
  await expect(page.getByText("Участник создан. Пароль больше не отображается.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Пароль")).toHaveValue("");
}

async function resetMember(page: Page, loginValue: string, password: string): Promise<void> {
  const row = page.getByRole("listitem").filter({ hasText: loginValue });
  await row.getByRole("button", { name: "Сбросить пароль" }).click();
  await row.getByLabel(`Новый пароль для ${loginValue}`).fill(password);
  await row.getByLabel("Подтверждаю завершение всех входов сотрудника").check();
  await row.getByRole("button", { name: "Сбросить пароль и завершить входы" }).click();
  await expect(row.getByRole("status")).toHaveText("Пароль сброшен. Все прежние сеансы завершены.");
}

async function disableMember(page: Page, loginValue: string): Promise<void> {
  const row = page.getByRole("listitem").filter({ hasText: loginValue });
  await row.getByRole("button", { name: "Отключить" }).click();
  await row.getByLabel("Подтверждаю отключение учётной записи и завершение всех входов").check();
  await row.getByRole("button", { name: "Подтвердить отключение" }).click();
  await expect(row.getByText("Отключён", { exact: true })).toBeVisible();
  await expect(row.getByRole("status")).toHaveText("Учётная запись отключена. Все прежние сеансы завершены.");
}

test.describe("trusted TLS session lifecycle", () => {
  test.skip(process.env.E2E_EXTERNAL_STACK !== "1", "TLS session checks require the isolated HTTPS Compose stack");

  test("serves a trusted HTTPS session, redirects HTTP, and rejects an untrusted CA", async ({ page, context, identity }) => {
    const pollingRequests: string[] = [];
    page.on("request", (request) => {
      if (!request.url().includes("/socket.io/")) return;
      const url = new URL(request.url());
      if (url.searchParams.get("transport") === "polling") pollingRequests.push(request.method());
    });

    const redirectResponse = await page.goto("http://proxy:80/healthz");
    expect(redirectResponse?.status()).toBe(200);
    expect(new URL(page.url()).origin).toBe(applicationOrigin);
    expect(new URL(page.url()).pathname).toBe("/healthz");

    const csrfResponse = await context.request.get(`${applicationOrigin}/api/auth/csrf`);
    expect(csrfResponse.status()).toBe(200);
    const setCookies = (await csrfResponse.headersArray())
      .filter(({ name }) => name.toLowerCase() === "set-cookie")
      .map(({ value }) => value);
    expect(setCookies).toHaveLength(1);
    const cookieParts = setCookies[0]!.split(";").map((part) => part.trim());
    expect(cookieParts[0]).toMatch(/^__Host-decentracord\.sid=/u);
    expect(cookieParts).toContain("Path=/");
    expect(cookieParts.some((part) => part.toLowerCase() === "httponly")).toBe(true);
    expect(cookieParts.some((part) => part.toLowerCase() === "secure")).toBe(true);
    expect(cookieParts.some((part) => part.toLowerCase() === "samesite=lax")).toBe(true);
    expect(cookieParts.some((part) => part.toLowerCase().startsWith("domain="))).toBe(false);

    const websocketPromise = page.waitForEvent("websocket", { predicate: isRealtimeWebSocket, timeout: 20_000 });
    await login(page, identity.admin);
    await expect(page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("подключено", { timeout: 15_000 });
    const websocket = await websocketPromise;
    expect(new URL(websocket.url()).protocol).toBe("wss:");
    expect(pollingRequests).toContain("GET");
    expect(pollingRequests).toContain("POST");

    const activeCookie = await sessionCookie(context);
    expect(await rejectedByUntrustedCa()).toBe(true);

    await page.getByRole("button", { name: "Выйти" }).click();
    await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
    await expectRevokedHttpSession(context, activeCookie.header);
    expect(await socketCanReconnect(activeCookie.header)).toBe(false);
  }, 90_000);

  test("password change, administrator reset, and disable revoke HTTPS sessions and block reconnects", async ({ browser, page, identity }) => {
    const memberLogin = `tls_member_${Date.now().toString(36)}`;
    const issuedPassword = "TLS-issued-password-2026-Secure";
    const resetPassword = "TLS-reset-password-2026-Secure";
    const changedPassword = "TLS-changed-password-2026-Secure";

    await login(page, identity.admin);
    await createMember(page, memberLogin, issuedPassword);

    let first = await authenticatedClient(browser, { login: memberLogin, password: issuedPassword });
    let second = await authenticatedClient(browser, { login: memberLogin, password: issuedPassword });
    const issuedCookies = [await sessionCookie(first.context), await sessionCookie(second.context)];
    const issuedWebSockets = [first.websocket, second.websocket];

    await resetMember(page, memberLogin, resetPassword);
    await expect(first.page.getByRole("heading", { name: "Вход" })).toBeVisible();
    await expect(second.page.getByRole("heading", { name: "Вход" })).toBeVisible();
    for (let index = 0; index < issuedCookies.length; index += 1) {
      await expectRevokedHttpSession(index === 0 ? first.context : second.context, issuedCookies[index]!.header);
      expect(await socketCanReconnect(issuedCookies[index]!.header)).toBe(false);
    }
    for (const websocket of issuedWebSockets) {
      await expect.poll(() => websocket.isClosed()).toBe(true);
    }
    await first.context.close();
    await second.context.close();

    const failedLogin = await browser.newPage();
    try {
      await failedLogin.goto(`${applicationOrigin}/`);
      await failedLogin.getByLabel("Логин").fill(memberLogin);
      await failedLogin.getByLabel("Пароль").fill(issuedPassword);
      await failedLogin.getByRole("button", { name: "Войти" }).click();
      await expect(failedLogin.getByRole("alert")).toContainText("Неверный логин или пароль");
    } finally {
      await failedLogin.close();
    }

    first = await authenticatedClient(browser, { login: memberLogin, password: resetPassword });
    second = await authenticatedClient(browser, { login: memberLogin, password: resetPassword });
    const resetCookies = [await sessionCookie(first.context), await sessionCookie(second.context)];
    const resetWebSockets = [first.websocket, second.websocket];
    await first.page.getByRole("button", { name: "Настройки аккаунта" }).click();
    await first.page.getByRole("textbox", { name: "Текущий пароль" }).fill(resetPassword);
    await first.page.getByRole("textbox", { name: "Новый пароль" }).fill(changedPassword);
    await first.page.getByRole("button", { name: "Сменить пароль" }).click();
    await expect(first.page.getByRole("heading", { name: "Вход" })).toBeVisible();
    await expect(second.page.getByRole("heading", { name: "Вход" })).toBeVisible();
    for (let index = 0; index < resetCookies.length; index += 1) {
      await expectRevokedHttpSession(index === 0 ? first.context : second.context, resetCookies[index]!.header);
      expect(await socketCanReconnect(resetCookies[index]!.header)).toBe(false);
    }
    for (const websocket of resetWebSockets) {
      await expect.poll(() => websocket.isClosed()).toBe(true);
    }
    await first.context.close();
    await second.context.close();

    first = await authenticatedClient(browser, { login: memberLogin, password: changedPassword });
    second = await authenticatedClient(browser, { login: memberLogin, password: changedPassword });
    const changedCookies = [await sessionCookie(first.context), await sessionCookie(second.context)];
    const changedWebSockets = [first.websocket, second.websocket];
    await disableMember(page, memberLogin);
    await expect(first.page.getByRole("heading", { name: "Вход" })).toBeVisible();
    await expect(second.page.getByRole("heading", { name: "Вход" })).toBeVisible();
    for (let index = 0; index < changedCookies.length; index += 1) {
      await expectRevokedHttpSession(index === 0 ? first.context : second.context, changedCookies[index]!.header);
      expect(await socketCanReconnect(changedCookies[index]!.header)).toBe(false);
    }
    for (const websocket of changedWebSockets) {
      await expect.poll(() => websocket.isClosed()).toBe(true);
    }

    const disabledLogin = await browser.newPage();
    try {
      await disabledLogin.goto(`${applicationOrigin}/`);
      await disabledLogin.getByLabel("Логин").fill(memberLogin);
      await disabledLogin.getByLabel("Пароль").fill(changedPassword);
      await disabledLogin.getByRole("button", { name: "Войти" }).click();
      await expect(disabledLogin.getByRole("alert")).toContainText("Неверный логин или пароль");
    } finally {
      await disabledLogin.close();
      await first.context.close();
      await second.context.close();
    }
  }, 180_000);
});
