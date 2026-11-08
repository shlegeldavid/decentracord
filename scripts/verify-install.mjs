import { accessSync, constants } from "node:fs";

function fail(code) {
  throw new Error(code);
}

function configuredOrigin() {
  const value = process.env.TEST_ORIGIN;
  if (!value || value.length > 512) fail("TEST_ORIGIN_REQUIRED");

  let origin;
  try {
    origin = new URL(value);
  } catch {
    fail("TEST_ORIGIN_INVALID");
  }

  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    fail("TEST_ORIGIN_INVALID");
  }

  const caFile = process.env.NODE_EXTRA_CA_CERTS;
  if (caFile) {
    try {
      accessSync(caFile, constants.R_OK);
    } catch {
      fail("CA_FILE_UNREADABLE");
    }
  }

  return origin;
}

async function checkedFetch(url, init, errorCode) {
  try {
    return await fetch(url, { ...init, redirect: "manual" });
  } catch {
    fail(errorCode);
  }
}

function hasCookieAttribute(attributes, expected) {
  return attributes.some((attribute) => attribute.trim().toLowerCase() === expected.toLowerCase());
}

async function verifyInstallation() {
  const origin = configuredOrigin();
  const expectedOrigin = origin.origin;

  const health = await checkedFetch(new URL("/healthz", expectedOrigin), { method: "GET" }, "HTTPS_REQUEST_FAILED");
  if (health.status !== 200) fail("HEALTH_CHECK_FAILED");
  let healthBody;
  try {
    healthBody = await health.json();
  } catch {
    fail("HEALTH_CHECK_FAILED");
  }
  if (!healthBody || healthBody.status !== "ok" || Object.keys(healthBody).length !== 1) {
    fail("HEALTH_CHECK_FAILED");
  }

  const httpOrigin = `http://${origin.hostname}`;
  const redirect = await checkedFetch(new URL("/healthz", httpOrigin), { method: "GET" }, "HTTP_REDIRECT_FAILED");
  const location = redirect.headers.get("location");
  if (!location || redirect.status < 300 || redirect.status > 399) fail("HTTP_REDIRECT_FAILED");
  let redirectTarget;
  try {
    redirectTarget = new URL(location, httpOrigin);
  } catch {
    fail("HTTP_REDIRECT_FAILED");
  }
  if (redirectTarget.origin !== expectedOrigin || redirectTarget.pathname !== "/healthz") {
    fail("HTTP_REDIRECT_FAILED");
  }

  const csrf = await checkedFetch(new URL("/api/auth/csrf", expectedOrigin), { method: "GET" }, "CSRF_CHECK_FAILED");
  if (csrf.status !== 200) fail("CSRF_CHECK_FAILED");
  let csrfBody;
  try {
    csrfBody = await csrf.json();
  } catch {
    fail("CSRF_CHECK_FAILED");
  }
  if (
    !csrfBody ||
    Object.keys(csrfBody).length !== 1 ||
    typeof csrfBody.csrfToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(csrfBody.csrfToken)
  ) {
    fail("CSRF_CHECK_FAILED");
  }

  const setCookies = csrf.headers.getSetCookie?.() ?? [csrf.headers.get("set-cookie")].filter(Boolean);
  if (setCookies.length !== 1) fail("CSRF_COOKIE_INVALID");
  const [cookieName, ...attributes] = setCookies[0].split(";");
  if (
    !cookieName.trim().startsWith("__Host-decentracord.sid=") ||
    !hasCookieAttribute(attributes, "Path=/") ||
    !hasCookieAttribute(attributes, "HttpOnly") ||
    !hasCookieAttribute(attributes, "Secure") ||
    !hasCookieAttribute(attributes, "SameSite=Lax") ||
    attributes.some((attribute) => attribute.trim().toLowerCase().startsWith("domain="))
  ) {
    fail("CSRF_COOKIE_INVALID");
  }

  process.stdout.write("HTTPS certificate and health endpoint: OK\n");
  process.stdout.write("HTTP redirect and pre-auth CSRF cookie: OK\n");
}

try {
  await verifyInstallation();
} catch (error) {
  const code = error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "VERIFICATION_FAILED";
  process.stderr.write(`Installation verification failed: ${code}\n`);
  process.exitCode = 1;
}
