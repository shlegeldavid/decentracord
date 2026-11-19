interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  data?: {
    hName?: string;
    [key: string]: unknown;
  };
}

interface MarkdownFile {
  value: unknown;
}

export function remarkDiscordUnderline() {
  return (tree: MarkdownNode, file: MarkdownFile): void => {
    const source = typeof file.value === "string" ? file.value : "";

    const visit = (parent: MarkdownNode): void => {
      if (!parent.children) return;

      for (const node of parent.children) {
        if (node.type === "strong") {
          const start = node.position?.start?.offset;
          const end = node.position?.end?.offset;
          if (start !== undefined && end !== undefined && source.slice(start, end).startsWith("__")) {
            node.type = "underline";
            node.data = { ...node.data, hName: "u" };
          }
        }

        visit(node);
      }
    };

    visit(tree);
  };
}
