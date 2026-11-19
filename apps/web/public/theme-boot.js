"use strict";

let storedTheme = null;
try {
  storedTheme = window.localStorage.getItem("decentracord:theme");
} catch {
  storedTheme = null;
}

const isLight = storedTheme === "light";
document.body.classList.toggle("light", isLight);

const themeColor = document.querySelector('meta[name="theme-color"]');
if (themeColor) {
  themeColor.setAttribute("content", isLight ? "#f2f1f6" : "#1f1f25");
}
