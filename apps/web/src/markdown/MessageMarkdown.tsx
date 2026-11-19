import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { spoilerPlugin } from "remark-inline-spoiler";
import { rehypeMentions } from "./rehype-mentions";
import { remarkDiscordUnderline } from "./remark-discord-underline";

type RehypeOptions = NonNullable<ComponentProps<typeof ReactMarkdown>["remarkRehypeOptions"]>;
type KnownHandler = NonNullable<NonNullable<RehypeOptions["handlers"]>["strong"]>;

const spoilerHandler: KnownHandler = (state, node) => ({
  type: "element",
  tagName: "span",
  properties: { className: ["spoiler"] },
  children: state.all(node)
});

// remark-inline-spoiler adds a custom node that is outside the built-in handler keys.
const spoilerHandlers = { spoiler: spoilerHandler } as unknown as NonNullable<RehypeOptions["handlers"]>;

interface MessageMarkdownProps {
  content: string;
  mentions: string[];
}

export function MessageMarkdown({ content, mentions }: MessageMarkdownProps) {
  return (
    <div className="message-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, spoilerPlugin, remarkDiscordUnderline]}
        rehypePlugins={[[rehypeMentions, { logins: mentions }]]}
        remarkRehypeOptions={{
          handlers: spoilerHandlers
        }}
        urlTransform={(url) => (/^(https?|mailto):/iu.test(url) ? url : "")}
        disallowedElements={["img", "iframe", "object", "embed", "form", "input", "style", "script"]}
        components={{
          a: ({ children }) => <span className="message-link">{children}</span>
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
