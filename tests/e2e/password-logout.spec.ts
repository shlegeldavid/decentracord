import { existsSync } from "node:fs";
import { test, expect, openSettingsSection } from "./fixtures.js";
import type { Browser, BrowserContext, Page } from "@playwright/test";

const storageStatePath = process.env.E2E_STORAGE_STATE_PATH ?? "/e2e-state/session.json";
const applicationOrigin = process.env.E2E_BASE_URL ?? "http://decentracord.test:3000";

async function login(page: Page, credentials: { login: string; password: string }): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
}

async function newAuthenticatedPage(
  browser: Browser,
  credentials: { login: string; password: string },
  observe?: (page: Page) => void
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  observe?.(page);
  await login(page, credentials);
  return { context, page };
}

test.describe("logout revokes only the current browser session", () => {
  test("logout clears private UI and keeps a second session active @logout", async ({ browser, context, page, identity }) => {
    const browserErrors: string[] = [];
    const transportEvents: string[] = [];
    const transportBodies: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("request", (request) => {
      if (!request.url().includes("/socket.io/")) return;
      transportEvents.push(`${request.method()} ${request.url()}`);
      void request.allHeaders().then((headers) => {
        transportEvents.push(`headers ${request.method()} ${request.url()} origin=${headers.origin ?? "<none>"} cookie=${headers.cookie ? "present" : "<none>"}`);
      });
    });
    page.on("response", (response) => {
      if (!response.url().includes("/socket.io/")) return;
      transportEvents.push(`response ${response.status()} ${response.url()}`);
      void response.text().then((body) => transportBodies.push(body)).catch(() => undefined);
    });
    page.on("requestfailed", (request) => {
      if (request.url().includes("/socket.io/")) transportEvents.push(`failed ${request.failure()?.errorText ?? "unknown"} ${request.url()}`);
    });
    await login(page, identity.admin);
    const meResponse = await context.request.get("/api/auth/me", { failOnStatusCode: false });
    const renderedState = await page.locator("body").innerText();
    await expect(
      page.getByRole("heading", { name: identity.organizationName }),
      `me=${meResponse.status()} body=${renderedState} browserErrors=${browserErrors.join(" | ")}`
    ).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(page.locator(".connection-status"), `transport=${transportEvents.join(" | ")} browserErrors=${browserErrors.join(" | ")}`).toContainText("подключено");
    await expect.poll(() => transportBodies.length).toBeGreaterThan(0);
    expect(transportEvents.some((event) => event.includes("headers GET") && event.includes("transport=polling") && event.includes("origin=<none>") && event.includes("cookie=present"))).toBe(true);
    expect(transportEvents.some((event) => event.includes("headers POST") && event.includes("transport=polling") && event.includes(`origin=${applicationOrigin}`))).toBe(true);
    expect(transportBodies.join("\n")).not.toMatch(/Организация|password_hash|csrfToken|e2e_admin/iu);

    const second = await newAuthenticatedPage(browser, identity.admin);
    const renewCsrf = Promise.withResolvers<void>();
    try {
      await expect(second.page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      await expect(second.page.locator(".connection-status")).toContainText("подключено");
      const sessionCookie = (await context.cookies(applicationOrigin)).find((cookie) => cookie.name.endsWith("decentracord.sid"));
      expect(sessionCookie).toBeTruthy();
      await context.storageState({ path: storageStatePath });

      await page.route("**/api/auth/csrf", async (route) => {
        await renewCsrf.promise;
        await route.continue();
      });
      await page.getByRole("button", { name: "Выйти" }).click();
      await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expect(page.getByLabel("Логин")).toBeFocused();
      await expect(page.getByLabel("Логин")).toHaveValue(identity.admin.login);
      await expect(page.getByLabel("Пароль")).toHaveValue("");
      const signIn = page.getByRole("button", { name: "Войти" });
      await expect(signIn).toBeDisabled();
      renewCsrf.resolve();
      await expect(signIn).toBeEnabled();
      await expect(page.getByText(identity.organizationName, { exact: true })).toHaveCount(0);
      await expect(second.page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      await expect(second.page.locator(".connection-status")).toContainText("подключено");

      const staleCookieResponse = await context.request.get("/api/auth/me", {
        failOnStatusCode: false,
        headers: { cookie: `${sessionCookie!.name}=${sessionCookie!.value}` }
      });
      expect(staleCookieResponse.status()).toBe(401);
      expect(await staleCookieResponse.text()).not.toMatch(/Организация|password_hash/iu);
      expect((await context.request.get("/api/auth/me", { failOnStatusCode: false })).status()).toBe(401);
    } finally {
      renewCsrf.resolve();
      await page.unroute("**/api/auth/csrf");
      await second.context.close();
    }
  });

  test("employee can voluntarily change password and revoke every session", async ({ browser, identity }) => {
    const employee = identity.employee;
    expect(employee).toBeTruthy();
    if (!employee) return;

    const changedPassword = `Changed-password-${Date.now()}-Secure`;
    const first = await newAuthenticatedPage(browser, employee);
    const secondTransport: string[] = [];
    const second = await newAuthenticatedPage(browser, employee, (secondPage) => {
      secondPage.on("response", (response) => {
        if (!response.url().includes("/socket.io/")) return;
        const url = new URL(response.url());
        const transport = url.searchParams.get("transport") ?? "unknown";
        secondTransport.push(`${response.request().method()} ${response.status()} ${url.pathname} transport=${transport}`);
      });
      secondPage.on("requestfailed", (request) => {
        if (!request.url().includes("/socket.io/")) return;
        const url = new URL(request.url());
        const transport = url.searchParams.get("transport") ?? "unknown";
        secondTransport.push(`failed ${request.failure()?.errorText ?? "unknown"} ${request.method()} ${url.pathname} transport=${transport}`);
      });
    });
    const fresh = await browser.newPage();
    try {
      await expect(first.page.getByRole("heading", { name: identity.organizationName })).toBeVisible({ timeout: 10_000 });
      await expect(second.page.getByRole("heading", { name: identity.organizationName })).toBeVisible({ timeout: 10_000 });
      await expect(first.page.locator(".connection-status")).toContainText("подключено", { timeout: 10_000 });
      await expect(second.page.locator(".connection-status"), `second transport=${secondTransport.join(" | ")}`).toContainText("подключено", { timeout: 10_000 });
      await openSettingsSection(first.page, "Настройки аккаунта");
      await expect(first.page.getByRole("heading", { name: "Настройки аккаунта" })).toBeVisible();

      const currentField = first.page.getByLabel("Текущий пароль", { exact: true });
      const newField = first.page.getByLabel("Новый пароль", { exact: true });
      await currentField.fill(employee.password);
      await newField.fill(changedPassword);
      await expect(currentField).toHaveAttribute("autocomplete", "current-password");
      await expect(newField).toHaveAttribute("autocomplete", "new-password");
      await first.page.getByRole("button", { name: "Показать текущий пароль" }).click();
      await expect(currentField).toHaveAttribute("type", "text");
      await expect(newField).toHaveAttribute("type", "password");
      await first.page.getByRole("button", { name: "Показать новый пароль" }).click();
      await expect(newField).toHaveAttribute("type", "text");
      await first.page.getByRole("button", { name: "Скрыть текущий пароль" }).click();
      await expect(currentField).toHaveAttribute("type", "password");
      await expect(newField).toHaveAttribute("type", "text");
      await first.page.getByRole("button", { name: "Скрыть новый пароль" }).click();
      await expect(newField).toHaveAttribute("type", "password");
      await first.page.getByRole("button", { name: "Сменить пароль" }).click();

      await expect(first.page.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expect(first.page.getByText("Пароль изменён. Войдите снова с новым паролем.")).toBeVisible();
      await expect(first.page.getByLabel("Пароль")).toHaveValue("");
      await expect(first.page.getByText(identity.organizationName, { exact: true })).toHaveCount(0);
      await expect(second.page.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expect(second.page.getByText(identity.organizationName, { exact: true })).toHaveCount(0);

      await fresh.goto("/");
      await expect(fresh.getByRole("heading", { name: "Вход" })).toBeVisible();
      await fresh.getByLabel("Логин").fill(employee.login);
      await fresh.getByLabel("Пароль").fill(changedPassword);
      await fresh.getByRole("button", { name: "Войти" }).click();
      await expect(fresh.getByRole("heading", { name: identity.organizationName })).toBeVisible();

      await second.page.getByLabel("Логин").fill(employee.login);
      await second.page.getByLabel("Пароль").fill(employee.password);
      await second.page.getByRole("button", { name: "Войти" }).click();
      await expect(second.page.getByRole("alert")).toContainText("Неверный логин или пароль");
    } finally {
      await first.context.close();
      await second.context.close();
      await fresh.close();
    }
  }, 90_000);

  test("browser cannot restore a saved cookie after logout and restart @logout @session-after-restart", async ({ browser }) => {
    expect(existsSync(storageStatePath)).toBe(true);
    const staleContext = await browser.newContext({ storageState: storageStatePath });
    try {
      const page = await staleContext.newPage();
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
      await expect(page.getByText("Организация", { exact: true })).toHaveCount(0);
      const response = await staleContext.request.get("/api/auth/me", { failOnStatusCode: false });
      expect(response.status()).toBe(401);
      expect(await response.text()).not.toMatch(/Организация|password_hash/iu);
    } finally {
      await staleContext.close();
    }
  });
});
