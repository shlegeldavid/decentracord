import { expect, openSettingsSection, test } from "./fixtures.js";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { Pool } from "pg";

const applicationOrigin = new URL(
  process.env.TEST_ORIGIN ?? process.env.E2E_BASE_URL ?? "http://decentracord.test:3000"
).origin;
const bootstrapStorageStatePath = process.env.E2E_BOOTSTRAP_STORAGE_STATE_PATH ?? "/e2e-state/bootstrap-session.json";

interface Credentials {
  login: string;
  password: string;
}

async function login(page: Page, credentials: Credentials): Promise<void> {
  await page.goto(`${applicationOrigin}/`);
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
}

async function newAuthenticatedPage(
  browser: Browser,
  credentials: Credentials
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await login(page, credentials);
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function csrfToken(context: BrowserContext): Promise<string> {
  const response = await context.request.get(`${applicationOrigin}/api/auth/csrf`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { csrfToken?: unknown };
  expect(typeof body.csrfToken).toBe("string");
  return body.csrfToken as string;
}

async function dragWithPointer(page: Page, source: Locator, target: Locator): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  const sourceBounds = await source.boundingBox();
  if (!sourceBounds) throw new Error("Drag source is not visible");
  await page.mouse.move(sourceBounds.x + sourceBounds.width / 2, sourceBounds.y + sourceBounds.height / 2);
  await page.mouse.down();
  // Сайдбар прокручивается одной областью: цель может быть видна только после прокрутки,
  // поэтому координаты цели читаются уже с зажатой кнопкой.
  await target.scrollIntoViewIfNeeded();
  const targetBounds = await target.boundingBox();
  if (!targetBounds) {
    await page.mouse.up();
    throw new Error("Drag target is not visible");
  }
  await page.mouse.move(targetBounds.x + targetBounds.width / 2, targetBounds.y + targetBounds.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function assignChannelToCategory(categoryId: string, channelId: string): Promise<void> {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? "");
  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (
    !["db", "localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) ||
    !/^decentracord_test(?:_[a-z0-9_-]+)?$/u.test(databaseName) ||
    !databaseUrl.password
  ) {
    throw new Error("Category E2E fixture database is not isolated");
  }

  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 1, connectionTimeoutMillis: 3_000 });
  try {
    const everyone = await pool.query<{ id: string; permissions: unknown }>(
      "SELECT id::text AS id, permissions FROM roles WHERE system_key = 'everyone'"
    );
    const role = everyone.rows[0];
    if (!role) throw new Error("@everyone role is missing from the category E2E fixture");
    const permissions = Array.isArray(role.permissions) ? role.permissions.filter((value): value is string => typeof value === "string") : [];
    if (!permissions.includes("VIEW_CHANNEL")) {
      await pool.query("UPDATE roles SET permissions = $1::jsonb WHERE id = $2", [JSON.stringify([...permissions, "VIEW_CHANNEL"]), role.id]);
    }
    await pool.query("UPDATE channels SET category_id = $1 WHERE id = $2", [categoryId, channelId]);
  } finally {
    await pool.end();
  }
}

test.describe("channel categories", () => {
  test("lets a manager create a category and keeps read-only members out of category controls", async ({ browser, page, identity }) => {
    const employee = identity.employee;
    expect(employee).toBeTruthy();
    if (!employee) return;

    const suffix = Date.now().toString(36);
    const channelName = `category-uncategorized-${suffix}`;
    const categoryName = `Отдел продаж ${suffix}`;
    let employeeSession: { context: BrowserContext; page: Page } | undefined;
    try {
      await login(page, identity.admin);
      const csrf = await csrfToken(page.context());
      const channelResponse = await page.context().request.post(`${applicationOrigin}/api/channels`, {
        data: { name: channelName },
        headers: { origin: applicationOrigin, "x-csrf-token": csrf },
        failOnStatusCode: false
      });
      expect(channelResponse.status(), await channelResponse.text()).toBe(201);
      const channel = await channelResponse.json() as { id: string };

      employeeSession = await newAuthenticatedPage(browser, employee);
      await expect(page.getByRole("button", { name: "Создать категорию" }).within(page.locator(".channel-sidebar"))).toBeVisible();
      await page.getByRole("button", { name: "Создать категорию" }).within(page.locator(".channel-sidebar")).click();
      const dialog = page.getByRole("dialog", { name: "Создать категорию" });
      await page.getByLabel("Название категории").within(dialog).fill(categoryName);
      await page.getByRole("button", { name: "Создать категорию" }).within(dialog).click();

      const category = page.locator(".channel-category[data-category-id]").filter({ hasText: categoryName });
      await expect(category).toBeVisible();
      await expect(page.locator(`.channel-category[data-category-id="__uncategorized__"] [data-channel-id="${channel.id}"]`)).toBeVisible();
      await expect(page.getByText("Без категории").within(page.locator(".channel-category"))).toBeVisible();

      const employeePage = employeeSession.page;
      await expect(employeePage.getByRole("button", { name: "Создать категорию" }).within(employeePage.locator(".channel-sidebar"))).toHaveCount(0);
      await expect(employeePage.getByRole("button", { name: `Действия с каналом «${channelName}»` }).within(employeePage.locator(".channel-sidebar"))).toHaveCount(0);
      await expect(employeePage.getByText("Без категории").within(employeePage.locator(".channel-category"))).toBeVisible();
    } finally {
      await employeeSession?.context.close();
    }
  });

  test("creates channels from the list and category with editable privacy defaults", async ({ browser, page, identity }) => {
    const employee = identity.employee;
    expect(employee).toBeTruthy();
    if (!employee) return;

    await login(page, identity.admin);
    const csrf = await csrfToken(page.context());
    const suffix = Date.now().toString(36);
    const categoryName = `Отдел продаж ${suffix}`;
    const categoryResponse = await page.context().request.post(`${applicationOrigin}/api/channels/categories`, {
      data: { name: categoryName },
      headers: { origin: applicationOrigin, "x-csrf-token": csrf },
      failOnStatusCode: false
    });
    expect(categoryResponse.status(), await categoryResponse.text()).toBe(201);
    const category = await categoryResponse.json() as { id: string; name: string };

    const anchorResponse = await page.context().request.post(`${applicationOrigin}/api/channels`, {
      data: { name: `category-anchor-${suffix}` },
      headers: { origin: applicationOrigin, "x-csrf-token": csrf },
      failOnStatusCode: false
    });
    expect(anchorResponse.status(), await anchorResponse.text()).toBe(201);
    const anchor = await anchorResponse.json() as { id: string };
    await assignChannelToCategory(category.id, anchor.id);
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible();

    const sidebar = page.locator(".channel-sidebar");
    await page.getByRole("button", { name: "Создать канал", exact: true }).within(sidebar).click();
    const createDialog = page.getByRole("dialog", { name: "Создать канал" });
    await expect(createDialog).toBeVisible();
    await expect(page.getByText("Канал появится в разделе «Без категории»").within(createDialog)).toBeVisible();
    const permissionGrid = createDialog.getByRole("region", { name: "Права доступа" });
    await expect(permissionGrid.getByLabel("Роль или участник")).toHaveValue("everyone");
    const everyoneView = page.getByLabel("@everyone: Видеть канал").within(permissionGrid);
    const everyoneSend = page.getByLabel("@everyone: Отправлять сообщения").within(permissionGrid);
    const everyoneManage = page.getByLabel("@everyone: Управлять сообщениями").within(permissionGrid);
    await expect(everyoneView).toHaveValue("allow");
    await expect(everyoneSend).toHaveValue("allow");
    await expect(everyoneManage).toHaveValue("unset");
    await expect(everyoneView.locator("option")).toHaveText(["Не задано", "Разрешить", "Запретить"]);

    const privacyToggle = page.getByRole("switch", { name: "Приватный канал" }).within(createDialog);
    const privacyLabel = createDialog.locator(".channel-private-toggle");
    await privacyLabel.click();
    await expect(privacyToggle).toBeChecked();
    await expect(everyoneView).toHaveValue("deny");
    await privacyLabel.click();
    await expect(privacyToggle).not.toBeChecked();
    await expect(everyoneView).toHaveValue("allow");

    const unassignedName = `created-from-list-${suffix}`;
    await page.getByLabel("Название канала").within(createDialog).fill(unassignedName);
    await page.getByLabel("Тема канала").within(createDialog).fill("Канал для общих объявлений");
    await page.getByRole("button", { name: "Создать канал" }).within(createDialog).click();
    await expect(createDialog).toHaveCount(0);

    const createdFromListResponse = await page.context().request.get(`${applicationOrigin}/api/channels`);
    expect(createdFromListResponse.status()).toBe(200);
    const createdFromList = (await createdFromListResponse.json() as {
      channels: Array<{ id: string; name: string; categoryId: string | null; description: string | null }>;
    }).channels.find((channel) => channel.name === unassignedName);
    expect(createdFromList).toMatchObject({ categoryId: null, description: "Канал для общих объявлений" });
    if (!createdFromList) throw new Error("Channel created from sidebar was missing from the channel list");
    await expect(page.locator(`.channel-category[data-category-id="__uncategorized__"] [data-channel-id="${createdFromList.id}"]`)).toBeVisible();

    await page.getByRole("button", { name: `Создать канал в категории «${categoryName}»` }).within(sidebar).click();
    const categoryDialog = page.getByRole("dialog", { name: "Создать канал" });
    await expect(page.getByText(`Канал появится в категории «${categoryName}»`).within(categoryDialog)).toBeVisible();
    const categorizedName = `created-in-category-${suffix}`;
    await page.getByLabel("Название канала").within(categoryDialog).fill(categorizedName);
    await page.getByRole("button", { name: "Создать канал" }).within(categoryDialog).click();
    await expect(categoryDialog).toHaveCount(0);

    const createdInCategoryResponse = await page.context().request.get(`${applicationOrigin}/api/channels`);
    expect(createdInCategoryResponse.status()).toBe(200);
    const createdInCategory = (await createdInCategoryResponse.json() as {
      channels: Array<{ id: string; name: string; categoryId: string | null }>;
    }).channels.find((channel) => channel.name === categorizedName);
    expect(createdInCategory?.categoryId).toBe(category.id);
    if (!createdInCategory) throw new Error("Channel created from category was missing from the channel list");
    await expect(page.locator(`.channel-category[data-category-id="${category.id}"] [data-channel-id="${createdInCategory.id}"]`)).toBeVisible();

    const employeeSession = await newAuthenticatedPage(browser, employee);
    try {
      const employeePage = employeeSession.page;
      const employeeSidebar = employeePage.locator(".channel-sidebar");
      await expect(employeePage.locator(`.channel-category[data-category-id="${category.id}"]`)).toBeVisible();
      await expect(employeePage.getByRole("button", { name: "Создать канал", exact: true }).within(employeeSidebar)).toHaveCount(0);
      await expect(employeePage.getByRole("button", { name: `Создать канал в категории «${categoryName}»` }).within(employeeSidebar)).toHaveCount(0);
    } finally {
      await employeeSession.context.close();
    }
  });

  test("reorders categories from the sidebar and exposes the same order in settings", async ({ page, identity }) => {
    await login(page, identity.admin);
    const csrf = await csrfToken(page.context());
    const suffix = Date.now().toString(36);
    const createdNames = [`Порядок один ${suffix}`, `Порядок два ${suffix}`];
    for (const name of createdNames) {
      const response = await page.context().request.post(`${applicationOrigin}/api/channels/categories`, {
        data: { name },
        headers: { origin: applicationOrigin, "x-csrf-token": csrf },
        failOnStatusCode: false
      });
      expect(response.status(), await response.text()).toBe(201);
    }

    const listResponse = await page.context().request.get(`${applicationOrigin}/api/channels/categories`);
    expect(listResponse.status()).toBe(200);
    const categories = await listResponse.json() as Array<{ id: string; name: string }>;
    expect(categories.length).toBeGreaterThanOrEqual(2);
    const first = categories[0]!;
    const last = categories[categories.length - 1]!;
    const sidebar = page.locator(".channel-sidebar");

    const firstTrigger = sidebar.getByRole("button", { name: `Действия с категорией «${first.name}»` });
    const lastTrigger = sidebar.getByRole("button", { name: `Действия с категорией «${last.name}»` });
    const firstMenu = page.getByRole("menu", { name: `Действия с категорией «${first.name}»` });
    const lastMenu = page.getByRole("menu", { name: `Действия с категорией «${last.name}»` });

    await firstTrigger.click();
    await expect(firstTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(firstMenu.getByRole("menuitem", { name: "Переместить выше" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(firstMenu).toHaveCount(0);
    await expect(firstTrigger).toBeFocused();

    await firstTrigger.click();
    await sidebar.getByRole("heading", { name: "Каналы", exact: true }).click();
    await expect(firstMenu).toHaveCount(0);
    await expect(firstTrigger).toHaveAttribute("aria-expanded", "false");

    await firstTrigger.click();
    await firstTrigger.click();
    await expect(firstMenu).toHaveCount(0);

    await lastTrigger.click();
    await expect(lastMenu).toBeVisible();
    await firstTrigger.focus();
    await expect(lastMenu).toHaveCount(0);
    await firstTrigger.click();
    await expect(firstMenu).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(firstMenu).toHaveCount(0);

    await lastTrigger.click();
    await lastMenu.getByRole("menuitem", { name: "Переместить выше" }).click();
    await expect(lastMenu).toHaveCount(0);
    await expect(lastTrigger).toBeFocused();
    const expectedIds = categories.map((category) => category.id);
    const previousIndex = expectedIds.length - 2;
    [expectedIds[previousIndex], expectedIds[expectedIds.length - 1]] = [
      expectedIds[expectedIds.length - 1]!,
      expectedIds[previousIndex]!
    ];
    await expect.poll(async () => page.locator(
      '.channel-sidebar .channel-category[data-category-id]:not([data-category-id="__uncategorized__"])'
    ).evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.categoryId))).toEqual(expectedIds);
    await page.keyboard.press("Escape");

    await openSettingsSection(page, "Каналы");
    await expect(page.locator(".settings-category-row")).toHaveCount(categories.length);
    const expectedNames = expectedIds.map((id) => categories.find((category) => category.id === id)!.name);
    await expect.poll(async () => page.locator(".settings-category-row .channel-category-name")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()))).toEqual(expectedNames);

    const settings = page.locator(".settings-modal");
    await page.getByRole("button", { name: "Создать категорию" }).within(settings).click();
    const createDialog = page.getByRole("dialog", { name: "Создать категорию" });
    await expect(createDialog).toBeVisible();
    await expect(page.getByLabel("Название категории").within(createDialog)).toBeVisible();
    await page.getByRole("button", { name: "Отмена" }).within(createDialog).click();
  });

  test("reorders channels and categories with pointer handles and persists the full order", async ({ browser, page, identity }) => {
    test.setTimeout(120_000);
    const employee = identity.employee;
    expect(employee).toBeTruthy();
    if (!employee) return;

    await login(page, identity.admin);
    const csrf = await csrfToken(page.context());
    const suffix = Date.now().toString(36);

    async function createCategory(name: string): Promise<{ id: string; name: string }> {
      const response = await page.context().request.post(`${applicationOrigin}/api/channels/categories`, {
        data: { name },
        headers: { origin: applicationOrigin, "x-csrf-token": csrf },
        failOnStatusCode: false
      });
      expect(response.status(), await response.text()).toBe(201);
      return await response.json() as { id: string; name: string };
    }

    async function createChannel(name: string, categoryId?: string): Promise<{ id: string }> {
      const response = await page.context().request.post(`${applicationOrigin}/api/channels`, {
        data: { name, ...(categoryId ? { categoryId } : {}) },
        headers: { origin: applicationOrigin, "x-csrf-token": csrf },
        failOnStatusCode: false
      });
      expect(response.status(), await response.text()).toBe(201);
      return await response.json() as { id: string };
    }

    const sourceCategory = await createCategory(`Перетаскивание источник ${suffix}`);
    const targetCategory = await createCategory(`Перетаскивание цель ${suffix}`);
    const movingChannel = await createChannel(`drag-channel-${suffix}`);
    await createChannel(`drag-source-anchor-${suffix}`, sourceCategory.id);
    await createChannel(`drag-target-anchor-${suffix}`, targetCategory.id);
    const categoriesResponse = await page.context().request.get(`${applicationOrigin}/api/channels/categories`);
    expect(categoriesResponse.status()).toBe(200);
    const existingCategories = await categoriesResponse.json() as Array<{ id: string }>;
    const categoryOrderResponse = await page.context().request.put(`${applicationOrigin}/api/channels/categories/order`, {
      data: { categoryIds: [targetCategory.id, ...existingCategories.map((category) => category.id).filter((id) => id !== targetCategory.id)] },
      headers: { origin: applicationOrigin, "x-csrf-token": csrf },
      failOnStatusCode: false
    });
    expect(categoryOrderResponse.status(), await categoryOrderResponse.text()).toBe(204);
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible();

    const channelFrom = page.locator(
      `.channel-category[data-category-id="__uncategorized__"] [data-channel-id="${movingChannel.id}"] .channel-drag-handle`
    );
    const categoryTarget = page.locator(`.channel-category[data-category-id="${targetCategory.id}"] .channel-category-header`);
    const channelOrderResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/channels/order" && response.request().method() === "PUT"
    );
    await dragWithPointer(page, channelFrom, categoryTarget);
    expect((await channelOrderResponse).status()).toBe(204);
    await expect(page.locator(
      `.channel-category[data-category-id="${targetCategory.id}"] [data-channel-id="${movingChannel.id}"]`
    )).toBeVisible();

    await page.reload();
    await expect(page.locator(
      `.channel-category[data-category-id="${targetCategory.id}"] [data-channel-id="${movingChannel.id}"]`
    )).toBeVisible();

    const channelToUncategorized = page.locator(
      `.channel-category[data-category-id="${targetCategory.id}"] [data-channel-id="${movingChannel.id}"] .channel-drag-handle`
    );
    const uncategorizedHeader = page.locator('.channel-category[data-category-id="__uncategorized__"] .channel-category-header');
    const uncategorizedOrderResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/channels/order" && response.request().method() === "PUT"
    );
    await dragWithPointer(page, channelToUncategorized, uncategorizedHeader);
    expect((await uncategorizedOrderResponse).status()).toBe(204);
    await expect(page.locator(
      `.channel-category[data-category-id="__uncategorized__"] [data-channel-id="${movingChannel.id}"]`
    )).toBeVisible();
    await page.reload();
    await expect(page.locator(
      `.channel-category[data-category-id="__uncategorized__"] [data-channel-id="${movingChannel.id}"]`
    )).toBeVisible();

    const categoryOrder = page.locator(
      '.channel-sidebar .channel-category[data-category-id]:not([data-category-id="__uncategorized__"])'
    );
    const beforeCategoryIds = await categoryOrder.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.categoryId)
    );
    const sourceIndex = beforeCategoryIds.indexOf(sourceCategory.id);
    const targetIndex = beforeCategoryIds.indexOf(targetCategory.id);
    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    const expectedCategoryIds = [...beforeCategoryIds];
    [expectedCategoryIds[sourceIndex], expectedCategoryIds[targetIndex]] = [
      expectedCategoryIds[targetIndex],
      expectedCategoryIds[sourceIndex]
    ];
    const categoryDragResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/channels/categories/order" && response.request().method() === "PUT"
    );
    await dragWithPointer(
      page,
      page.locator(`.channel-category[data-category-id="${sourceCategory.id}"] .channel-category-drag`),
      page.locator(`.channel-category[data-category-id="${targetCategory.id}"] .channel-category-header`)
    );
    expect((await categoryDragResponse).status()).toBe(204);
    await expect.poll(async () => categoryOrder.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.categoryId)
    )).toEqual(expectedCategoryIds);
    await page.reload();
    await expect.poll(async () => page.locator(
      '.channel-sidebar .channel-category[data-category-id]:not([data-category-id="__uncategorized__"])'
    ).evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.categoryId))).toEqual(expectedCategoryIds);

    const employeeSession = await newAuthenticatedPage(browser, employee);
    try {
      await expect(employeeSession.page.locator(".channel-drag-handle")).toHaveCount(0);
      await expect(employeeSession.page.locator(".channel-category-drag")).toHaveCount(0);
    } finally {
      await employeeSession.context.close();
    }
  });

  test("moves a channel from its action menu and hides that menu from read-only members", async ({ browser, page, identity }) => {
    const employee = identity.employee;
    expect(employee).toBeTruthy();
    if (!employee) return;

    await login(page, identity.admin);
    const csrf = await csrfToken(page.context());
    const suffix = Date.now().toString(36);
    const channelName = `channel-move-${suffix}`;
    const sourceName = `Источник ${suffix}`;
    const targetName = `Цель ${suffix}`;
    const channelResponse = await page.context().request.post(`${applicationOrigin}/api/channels`, {
      data: { name: channelName },
      headers: { origin: applicationOrigin, "x-csrf-token": csrf },
      failOnStatusCode: false
    });
    expect(channelResponse.status(), await channelResponse.text()).toBe(201);
    const channel = await channelResponse.json() as { id: string };
    const categories: Array<{ id: string; name: string }> = [];
    for (const name of [sourceName, targetName]) {
      const response = await page.context().request.post(`${applicationOrigin}/api/channels/categories`, {
        data: { name },
        headers: { origin: applicationOrigin, "x-csrf-token": csrf },
        failOnStatusCode: false
      });
      expect(response.status(), await response.text()).toBe(201);
      categories.push(await response.json() as { id: string; name: string });
    }
    await assignChannelToCategory(categories[0]!.id, channel.id);

    const sidebar = page.locator(".channel-sidebar");
    await expect(page.getByRole("button", { name: channelName, exact: true }).within(sidebar)).toBeVisible();
    const menuTrigger = sidebar.getByRole("button", { name: `Действия с каналом «${channelName}»` });
    const menu = page.getByRole("menu", { name: `Действия с каналом «${channelName}»` });
    await menuTrigger.click();
    await expect(menu).toBeVisible();
    await sidebar.getByRole("heading", { name: "Каналы", exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(menuTrigger).toHaveAttribute("aria-expanded", "false");
    await menuTrigger.click();
    await menuTrigger.click();
    await expect(menu).toHaveCount(0);
    await menuTrigger.click();
    await menu.getByRole("menuitem", { name: "Переместить в категорию…" }).click();

    const dialog = page.getByRole("dialog", { name: `Переместить канал «${channelName}»` });
    const targetRadio = page.getByRole("radio", { name: targetName }).within(dialog);
    await targetRadio.check();
    const moveButton = page.getByRole("button", { name: "Переместить" }).within(dialog);
    const channelRoute = `**/api/channels/${channel.id}`;
    await page.route(channelRoute, (route) => route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL", message: "ошибка" } })
    }));
    await moveButton.click();
    await expect(dialog.locator(".channel-dialog-error")).toHaveText("Не удалось переместить канал. Попробуйте ещё раз.");
    await expect(targetRadio).toBeChecked();
    await expect(dialog).toBeVisible();
    await page.unroute(channelRoute);

    await moveButton.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(`.channel-category[data-category-id="${categories[1]!.id}"] [data-channel-id="${channel.id}"]`)).toBeVisible();

    const employeeSession = await newAuthenticatedPage(browser, employee);
    try {
      const employeePage = employeeSession.page;
      await expect(employeePage.locator(`.channel-category[data-category-id="${categories[1]!.id}"] [data-channel-id="${channel.id}"]`)).toBeVisible();
      await expect(employeePage.getByRole("button", { name: `Действия с каналом «${channelName}»` }).within(employeePage.locator(".channel-sidebar"))).toHaveCount(0);
    } finally {
      await employeeSession.context.close();
    }
  });

  test("lets managers rename and delete a category and resets confirmation after failure", async ({ browser, page, identity }) => {
    const employee = identity.employee;
    expect(employee).toBeTruthy();
    if (!employee) return;

    const suffix = Date.now().toString(36);
    const channelName = `category-delete-${suffix}`;
    const categoryName = `Отдел продаж ${suffix}`;
    const updatedCategoryName = `Отдел закупок ${suffix}`;
    let employeeSession: { context: BrowserContext; page: Page } | undefined;
    try {
      await login(page, identity.admin);
      const csrf = await csrfToken(page.context());
      const channelResponse = await page.context().request.post(`${applicationOrigin}/api/channels`, {
        data: { name: channelName },
        headers: { origin: applicationOrigin, "x-csrf-token": csrf },
        failOnStatusCode: false
      });
      expect(channelResponse.status(), await channelResponse.text()).toBe(201);
      const channel = await channelResponse.json() as { id: string };
      const categoryResponse = await page.context().request.post(`${applicationOrigin}/api/channels/categories`, {
        data: { name: categoryName },
        headers: { origin: applicationOrigin, "x-csrf-token": csrf },
        failOnStatusCode: false
      });
      expect(categoryResponse.status(), await categoryResponse.text()).toBe(201);
      const category = await categoryResponse.json() as { id: string };
      await assignChannelToCategory(category.id, channel.id);

      employeeSession = await newAuthenticatedPage(browser, employee);
      const employeePage = employeeSession.page;
      await expect(employeePage.locator(`.channel-category[data-category-id="${category.id}"]`)).toBeVisible();
      await expect(employeePage.getByRole("button", { name: `Действия с категорией «${categoryName}»` }).within(employeePage.locator(".channel-sidebar"))).toHaveCount(0);

      const categoryActions = page.getByRole("button", { name: `Действия с категорией «${categoryName}»` }).within(page.locator(".channel-sidebar"));
      await categoryActions.click();
      await page.getByRole("menuitem", { name: "Переименовать" }).within(page.locator(".context-menu")).click();
      const renameDialog = page.getByRole("dialog", { name: "Переименовать категорию" });
      const categoryNameField = page.getByLabel("Название категории").within(renameDialog);
      await expect(categoryNameField).toHaveValue(categoryName);
      await categoryNameField.fill(updatedCategoryName);
      await page.getByRole("button", { name: "Сохранить название категории" }).within(renameDialog).click();
      await expect(page.locator(`.channel-category[data-category-id="${category.id}"] .channel-category-name`)).toHaveText(updatedCategoryName);

      await page.getByRole("button", { name: `Действия с категорией «${updatedCategoryName}»` }).within(page.locator(".channel-sidebar")).click();
      await page.getByRole("menuitem", { name: "Удалить" }).within(page.locator(".context-menu")).click();
      const deleteDialog = page.getByRole("dialog", { name: `Удалить категорию «${updatedCategoryName}»` });
      const confirmCheckbox = page.getByRole("checkbox", {
        name: "Подтверждаю удаление категории и перенос её каналов в «Без категории»"
      }).within(deleteDialog);
      const deleteButton = page.getByRole("button", { name: "Удалить" }).within(deleteDialog);
      await expect(deleteButton).toBeDisabled();
      await confirmCheckbox.check();

      await page.route("**/api/channels/categories/*", (route) => route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INTERNAL", message: "ошибка" } })
      }));
      await deleteButton.click();
      await expect(page.locator(".confirm-dialog")).toBeVisible();
      await expect(deleteDialog.locator(".channel-dialog-error")).toHaveText("Не удалось удалить категорию. Попробуйте ещё раз.");
      await expect(confirmCheckbox).not.toBeChecked();
      await expect(confirmCheckbox).toBeFocused();
      await page.unroute("**/api/channels/categories/*");

      await confirmCheckbox.check();
      await deleteButton.click();
      await expect(page.locator(`.channel-category[data-category-id="${category.id}"]`)).toHaveCount(0);
      await expect(page.locator(`.channel-category[data-category-id="__uncategorized__"] [data-channel-id="${channel.id}"]`)).toBeVisible();
    } finally {
      await employeeSession?.context.close();
    }
  });

  test("collapses categories with persistent unread totals and keeps keyboard focus on visible channels", async ({ browser, page, identity }) => {
    const employee = identity.employee;
    expect(employee).toBeTruthy();
    if (!employee) return;

    await login(page, identity.admin);
    const csrf = await csrfToken(page.context());
    const suffix = Date.now().toString(36);
    const categoryNames = [`Сворачиваемая ${suffix}`, `Пропускаемая ${suffix}`, `Следующая ${suffix}`];
    const categories: Array<{ id: string; name: string }> = [];
    for (const name of categoryNames) {
      const response = await page.context().request.post(`${applicationOrigin}/api/channels/categories`, {
        data: { name },
        headers: { origin: applicationOrigin, "x-csrf-token": csrf },
        failOnStatusCode: false
      });
      expect(response.status(), await response.text()).toBe(201);
      categories.push(await response.json() as { id: string; name: string });
    }

    const channelIds: string[] = [];
    for (const name of [
      `collapse-first-${suffix}`,
      `collapse-last-${suffix}`,
      `collapse-middle-${suffix}`,
      `collapse-next-${suffix}`,
      `collapse-uncategorized-${suffix}`
    ]) {
      const response = await page.context().request.post(`${applicationOrigin}/api/channels`, {
        data: { name },
        headers: { origin: applicationOrigin, "x-csrf-token": csrf },
        failOnStatusCode: false
      });
      expect(response.status(), await response.text()).toBe(201);
      const channel = await response.json() as { id: string };
      channelIds.push(channel.id);
    }
    await assignChannelToCategory(categories[0]!.id, channelIds[0]!);
    await assignChannelToCategory(categories[0]!.id, channelIds[1]!);
    await assignChannelToCategory(categories[1]!.id, channelIds[2]!);
    await assignChannelToCategory(categories[2]!.id, channelIds[3]!);

    const unreadByChannel = new Map([
      [channelIds[0]!, 2],
      [channelIds[1]!, 3],
      [channelIds[2]!, 7]
    ]);
    await page.route("**/api/channels", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.json() as { channels: Array<{ id: string; unreadCount?: number }> };
      body.channels = body.channels.map((channel) => {
        const unreadCount = unreadByChannel.get(channel.id);
        return unreadCount === undefined ? channel : { ...channel, unreadCount };
      });
      await route.fulfill({ response, body: JSON.stringify(body) });
    });
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible();

    const categoryOne = page.locator(`.channel-category[data-category-id="${categories[0]!.id}"]`);
    const categoryTwo = page.locator(`.channel-category[data-category-id="${categories[1]!.id}"]`);
    const categoryThree = page.locator(`.channel-category[data-category-id="${categories[2]!.id}"]`);
    const uncategorized = page.locator('.channel-category[data-category-id="__uncategorized__"]');
    const channelRow = (channelId: string) => page.locator(
      `.channel-list[data-scope="workspace"] [data-channel-id="${channelId}"]`
    );
    const channelButton = (channelId: string) => channelRow(channelId).locator(".channel-list-select");

    await expect(categoryOne.locator(".channel-category-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(categoryOne.locator(".channel-category-badge")).toHaveCount(0);
    await expect(categoryTwo.locator(".channel-category-badge")).toHaveCount(0);
    await categoryOne.locator(".channel-category-toggle").click();
    await expect(categoryOne.locator(".channel-category-toggle")).toHaveAttribute("aria-label", `Развернуть категорию «${categories[0]!.name}»`);
    await expect(channelRow(channelIds[0]!)).toHaveCount(0);
    await expect(channelRow(channelIds[1]!)).toHaveCount(0);
    await expect(categoryOne.locator(".channel-category-badge")).toHaveText("5");
    await expect(categoryOne.locator(".channel-category-badge")).toHaveAttribute(
      "aria-label",
      `5 непрочитанных в категории «${categories[0]!.name}»`
    );
    await expect(categoryTwo.locator(".channel-category-badge")).toHaveCount(0);

    const employeeSession = await newAuthenticatedPage(browser, employee);
    try {
      const employeeCategory = employeeSession.page.locator(`.channel-category[data-category-id="${categories[0]!.id}"]`);
      await expect(employeeCategory.locator(".channel-category-toggle")).toHaveAttribute("aria-expanded", "true");
    } finally {
      await employeeSession.context.close();
    }

    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(categoryOne.locator(".channel-category-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(channelRow(channelIds[0]!)).toHaveCount(0);

    await categoryOne.locator(".channel-category-toggle").click();
    await expect(categoryOne.locator(".channel-category-badge")).toHaveCount(0);
    await expect(channelRow(channelIds[0]!)).toBeVisible();

    await page.getByRole("button", { name: `Действия с категорией «${categories[2]!.name}»` })
      .within(categoryThree)
      .click();
    const categoryMenu = page.locator(".context-menu");
    await page.getByRole("menuitem", { name: "Свернуть", exact: true }).within(categoryMenu).click();
    await expect(categoryThree.locator(".channel-category-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(channelRow(channelIds[3]!)).toHaveCount(0);
    await page.getByRole("button", { name: `Действия с категорией «${categories[2]!.name}»` })
      .within(categoryThree)
      .click();
    await page.getByRole("menuitem", { name: "Развернуть", exact: true }).within(page.locator(".context-menu")).click();
    await expect(channelRow(channelIds[3]!)).toBeVisible();

    await uncategorized.locator(".channel-category-toggle").click();
    await expect(uncategorized.locator(".channel-category-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(channelRow(channelIds[4]!)).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(uncategorized.locator(".channel-category-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(uncategorized.locator(".channel-category-toggle")).toHaveAttribute(
      "aria-label",
      "Развернуть раздел «Без категории»"
    );
    await uncategorized.locator(".channel-category-toggle").click();
    await expect(channelRow(channelIds[4]!)).toBeVisible();

    await channelButton(channelIds[1]!).focus();
    await page.keyboard.press("ArrowDown");
    await expect(channelButton(channelIds[2]!)).toBeFocused();

    await categoryTwo.locator(".channel-category-toggle").click();
    await channelButton(channelIds[1]!).focus();
    await page.keyboard.press("ArrowDown");
    await expect(channelButton(channelIds[3]!)).toBeFocused();
    await expect(channelRow(channelIds[2]!)).toHaveCount(0);

    const visibleChannelButtons = page.locator('.channel-list[data-scope="workspace"] .channel-list-select:visible');
    await channelButton(channelIds[3]!).focus();
    await page.keyboard.press("Home");
    await expect(visibleChannelButtons.first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(visibleChannelButtons.last()).toBeFocused();
  });

  test("keeps collapsed category state separate when users switch in the same browser context", async ({ page, identity }) => {
    const employee = identity.employee;
    expect(employee).toBeTruthy();
    if (!employee) return;

    await login(page, identity.admin);
    const csrf = await csrfToken(page.context());
    const suffix = Date.now().toString(36);
    const categoryResponse = await page.context().request.post(`${applicationOrigin}/api/channels/categories`, {
      data: { name: `Персональное сворачивание ${suffix}` },
      headers: { origin: applicationOrigin, "x-csrf-token": csrf },
      failOnStatusCode: false
    });
    expect(categoryResponse.status(), await categoryResponse.text()).toBe(201);
    const category = await categoryResponse.json() as { id: string; name: string };
    const channelResponse = await page.context().request.post(`${applicationOrigin}/api/channels`, {
      data: {
        name: `personal-collapse-${suffix}`,
        categoryId: category.id,
        overrides: [{ subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" }]
      },
      headers: { origin: applicationOrigin, "x-csrf-token": csrf },
      failOnStatusCode: false
    });
    expect(channelResponse.status(), await channelResponse.text()).toBe(201);

    const categoryRow = page.locator(`.channel-category[data-category-id="${category.id}"]`);
    const toggle = categoryRow.locator(".channel-category-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await page.getByRole("button", { name: "Выйти" }).click();
    await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
    await login(page, employee);
    await expect(categoryRow).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await page.getByRole("button", { name: "Выйти" }).click();
    await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
    await login(page, identity.admin);
    await expect(categoryRow).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("prepares a persistent category for the restart check", async ({ page, identity }) => {
    await login(page, identity.admin);
    await page.context().storageState({ path: bootstrapStorageStatePath });
    const csrf = await csrfToken(page.context());
    const response = await page.context().request.post(`${applicationOrigin}/api/channels/categories`, {
      data: { name: "e2e-category-restart" },
      headers: { origin: applicationOrigin, "x-csrf-token": csrf },
      failOnStatusCode: false
    });
    expect(response.status(), await response.text()).toBe(201);
  });

  test("keeps categories available after the app and database restart @session-after-restart", async ({ browser, identity }) => {
    const context = await browser.newContext({
      baseURL: applicationOrigin,
      storageState: bootstrapStorageStatePath
    });
    try {
      const page = await context.newPage();
      await page.goto(`${applicationOrigin}/`);
      await expect(page.getByRole("heading", { name: identity.organizationName })).toBeVisible();
      const response = await context.request.get(`${applicationOrigin}/api/channels`);
      expect(response.status()).toBe(200);
      const body = await response.json() as { categories: Array<{ id: string; name: string }> };
      const category = body.categories.find((entry) => entry.name === "e2e-category-restart");
      expect(category).toBeTruthy();
      if (!category) throw new Error("Persistent category was missing after restart");
      await expect(page.locator(`.channel-category[data-category-id="${category.id}"]`)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
