import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import { parseMentionTokens } from "./tokens";

interface RehypeMentionsOptions {
  logins: string[];
}

function mentionElements(node: Text, logins: string[]): ElementContent[] {
  const confirmedMentions = logins.map((login) => ({ id: login, login }));

  return parseMentionTokens(node.value, confirmedMentions).map((token) => {
    if (token.type === "mention") {
      return {
        type: "element",
        tagName: "span",
        properties: { className: ["mention"] },
        children: [{ type: "text", value: token.value }]
      } satisfies Element;
    }

    return { type: "text", value: token.value } satisfies Text;
  });
}

function transformElement(element: Element, logins: string[]): void {
  const children: ElementContent[] = [];

  for (const child of element.children) {
    if (child.type === "text") {
      children.push(...mentionElements(child, logins));
    } else {
      if (child.type === "element") transformElement(child, logins);
      children.push(child);
    }
  }

  element.children = children;
}

function transformRoot(root: Root, logins: string[]): void {
  const children: RootContent[] = [];

  for (const child of root.children) {
    if (child.type === "text") {
      children.push(...mentionElements(child, logins));
    } else {
      if (child.type === "element") transformElement(child, logins);
      children.push(child);
    }
  }

  root.children = children;
}

export function rehypeMentions({ logins }: RehypeMentionsOptions) {
  return (tree: Root): void => transformRoot(tree, logins);
}
