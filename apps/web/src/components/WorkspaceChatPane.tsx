import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import {
  ApiError,
  forwardMessageToChannel,
  forwardMessageToConversation,
  type Channel,
  type ChannelCategory,
  type Conversation,
  type MessageView
} from "../api";
import type { useChannelPins } from "../hooks/useChannelPins";
import { messageScopeKey, type MessageScope } from "../lib/messageHistory";
import { DmHeader } from "./DmHeader";
import { DmHiddenCard } from "./DmHiddenCard";
import { ForwardMessageDialog, type ForwardDestination } from "./ForwardMessageDialog";
import { GearIcon } from "./icons";
import { MessageComposer } from "./MessageComposer";
import { MessageFeed } from "./MessageFeed";
import { MessageReadersModal } from "./MessageReadersModal";
import { PinnedMessagesPanel } from "./PinnedMessagesPanel";
import { RevokedAccessCard } from "./RevokedAccessCard";
import { TypingIndicator } from "./TypingIndicator";

type FeedProps = ComponentProps<typeof MessageFeed>;
type ChatHistory = Pick<FeedProps, "messages" | "pending" | "hasMoreHistory" | "historyLoadState"> & {
  channelLastReadSeq: number;
  loadChannelEarlier: FeedProps["onLoadEarlier"];
  loadConversationEarlier: (id: string, before: number | undefined) => Promise<void>;
};
type ChatFormat = Pick<FeedProps, "theme" | "timeZone" | "dayKey" | "formatMessageTime">;
type ChatComposer = Pick<ComponentProps<typeof MessageComposer>, "value" | "onChange" | "offline" | "csrfToken" | "errorMessage">;

type ChatScope =
  | { kind: "channel"; channel: Channel; revokedReason: string | null }
  | {
      kind: "conversation";
      conversation: Conversation;
      hidden: boolean;
      typingLabel: string | null;
      onType: () => void;
      onBack: () => void;
    };

type MessageActions = {
  retry: (kind: MessageScope, clientRequestId: string) => void;
  edit: (kind: MessageScope, messageId: string, content: string) => Promise<boolean>;
  remove: (kind: MessageScope, messageId: string) => Promise<void>;
  submit: (kind: MessageScope, content: string, csrfToken: string) => void;
};

type ChannelChatHeadingProps = {
  channel: Channel | null;
  pinsOpen: boolean;
  topicExpanded: boolean;
  openPins: () => void;
  toggleTopic: (channelId: string) => void;
  openProperties: (channel: Channel) => void;
};

function ChannelChatHeading({ channel, pinsOpen, topicExpanded, openPins, toggleTopic, openProperties }: ChannelChatHeadingProps) {
  const description = channel?.canView ? channel.description : null;
  const topicId = channel ? `channel-topic-expanded-${channel.id}` : "";

  return (
    <>
      <header className="chat-pane-header">
        <span className="channel-hash" aria-hidden="true">#</span>
        <h2 id="workspace-messages-title">
          <button
            type="button"
            className="channel-name-trigger"
            aria-expanded={pinsOpen}
            aria-controls="channel-pins-panel"
            onClick={() => { if (channel?.canView) openPins(); }}
          >
            {channel?.name ?? "Выберите канал"}
          </button>
        </h2>
        {channel && description && (
          <button
            type="button"
            className="channel-topic"
            aria-expanded={topicExpanded}
            aria-controls={topicId}
            onClick={() => toggleTopic(channel.id)}
          >
            {description}
          </button>
        )}
        {channel?.visibility === "known" && (
          <span className="channel-mode-badge">Известен всем, но закрыт</span>
        )}
        {channel?.ownerEditable && (
          <button
            type="button"
            className="icon-btn channel-properties-trigger"
            aria-label="Свойства канала"
            onClick={() => openProperties(channel)}
          >
            <GearIcon />
          </button>
        )}
      </header>
      {description && (
        <div id={topicId} className="channel-topic-expanded" hidden={!topicExpanded}>
          {description}
        </div>
      )}
    </>
  );
}

type ScopedChatProps = {
  scope: ChatScope;
  history: ChatHistory;
  format: ChatFormat;
  composer: ChatComposer;
  actions: MessageActions;
  currentUserId: string;
  onForward: (kind: MessageScope, message: MessageView) => void;
  channelActions: Pick<FeedProps,
    "onOpenReaders" | "isPinned" | "onPin" | "onUnpin" | "visibleChannelIds" | "onJumpToMessage"
  >;
  channelPanels: ReactNode;
};

function jumpToUnread(): void {
  const article = document.querySelector<HTMLElement>('.message-feed [data-first-unread="true"]');
  article?.scrollIntoView({ behavior: "auto", block: "start" });
  article?.focus({ preventScroll: true });
}

function canEditChannelMessage(message: MessageView): boolean {
  const createdAt = new Date(message.createdAt).getTime();
  const age = Date.now() - createdAt;
  return Number.isFinite(age) && age >= 0 && age < 3 * 24 * 60 * 60 * 1000;
}

function ScopedChat({ scope, history, format, composer, actions, currentUserId, onForward, channelActions, channelPanels }: ScopedChatProps) {
  const { kind } = scope;
  const channel = scope.kind === "channel" ? scope.channel : null;
  const id = scope.kind === "conversation" ? scope.conversation.id : scope.channel.id;
  const messageIdField = scope.kind === "conversation" ? "conversationId" : "channelId";
  const revoked = scope.kind === "channel" && scope.revokedReason !== null;
  const showComposer = scope.kind === "conversation" ? !scope.hidden : !revoked;
  const readOnly = channel?.canSend === false;
  const ownsMessage = (message: MessageView) => message.authorId === currentUserId;
  const canManageMessages = channel?.canManageMessages === true;
  const scopeKey = messageScopeKey(kind, id);
  const pending = history.pending.filter((message) => message.scopeKey === scopeKey);

  const scopeFeedProps = scope.kind === "conversation" ? {
    onLoadEarlier: (before: number | undefined) => history.loadConversationEarlier(id, before),
    canEdit: ownsMessage,
    canDelete: ownsMessage,
    showDelivery: true,
    emptyState: {
      heading: "Это начало переписки — напишите первое",
      body: scope.conversation.kind === "direct"
        ? "Отправьте первое сообщение — его увидит собеседник."
        : "Отправьте первое сообщение — его увидят участники переписки."
    }
  } : {
    ...channelActions,
    onLoadEarlier: history.loadChannelEarlier,
    canEdit: canEditChannelMessage,
    lastReadSeq: history.channelLastReadSeq,
    isRevoked: revoked,
    onJumpToUnread: jumpToUnread,
    canSeeReaders: ownsMessage,
    canPin: canManageMessages,
    canUnpin: (message: MessageView) => canManageMessages || ownsMessage(message)
  };

  return (
    <>
      <div className="message-stage">
        {scope.kind === "conversation" && scope.hidden && <DmHiddenCard onBack={scope.onBack} />}
        <MessageFeed
          key={kind}
          {...format}
          {...scopeFeedProps}
          currentUserId={currentUserId}
          channelId={id}
          messages={history.messages.filter((message) => message[messageIdField] === id)}
          pending={pending}
          hasMoreHistory={history.hasMoreHistory && !revoked}
          historyLoadState={history.historyLoadState}
          canManageMessages={canManageMessages}
          onRetry={(requestId) => actions.retry(kind, requestId)}
          onEdit={(messageId, content) => actions.edit(kind, messageId, content)}
          onDelete={(messageId) => void actions.remove(kind, messageId)}
          onForward={(message) => onForward(kind, message)}
        />
        {channelPanels}
      </div>
      {showComposer && (
        <>
          {scope.kind === "conversation" && <TypingIndicator label={scope.typingLabel} />}
          <MessageComposer
            key={kind}
            {...composer}
            isSending={pending.some((message) => message.state === "sending")}
            disabled={readOnly}
            {...(scope.kind === "conversation" ? { onInput: scope.onType } : {})}
            {...(readOnly ? { disabledReason: "канал только для чтения" } : {})}
            onSubmit={(content, token) => actions.submit(kind, content, token)}
          />
        </>
      )}
    </>
  );
}

type ForwardSource = { source: ForwardDestination; message: MessageView };

function jumpToMessage(messageId: string): boolean {
  const article = Array.from(document.querySelectorAll<HTMLElement>(".message-feed [data-message-id]"))
    .find((element) => element.dataset.messageId === messageId);
  if (!article) return false;
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  article.scrollIntoView({ behavior, block: "start" });
  article.focus({ preventScroll: true });
  return true;
}

interface WorkspaceChatPaneProps {
  inactive: boolean;
  currentUserId: string;
  scope: ChatScope | null;
  history: ChatHistory;
  format: ChatFormat;
  composer: ChatComposer;
  actions: MessageActions;
  channels: Channel[];
  categories: ChannelCategory[];
  conversations: Conversation[];
  selectedChannelId: RefObject<string | null>;
  pins: ReturnType<typeof useChannelPins>;
  topicExpanded: boolean;
  accessDenied: boolean;
  dmAnnouncements: [string, string];
  onToggleTopic: (id: string) => void;
  onOpenProperties: (channel: Channel) => void;
  onLeaveRevokedChannel: () => void;
  onSessionExpired: () => void;
  onSelectChannel: (channelId: string) => void;
  onForwarded: (message: MessageView) => void;
}

export function WorkspaceChatPane({
  inactive, currentUserId, scope, history, format, composer, actions, channels, categories, conversations,
  selectedChannelId, pins, topicExpanded, accessDenied, dmAnnouncements, onToggleTopic, onOpenProperties,
  onLeaveRevokedChannel, onSessionExpired, onSelectChannel, onForwarded
}: WorkspaceChatPaneProps) {
  const [readers, setReaders] = useState<{ channelId: string; messageId: string } | null>(null);
  const [forward, setForward] = useState<ForwardSource | null>(null);
  const [forwardAnnouncement, setForwardAnnouncement] = useState("");
  const pendingJump = useRef<string | null>(null);
  const active = useRef(true);

  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const visibleChannelIds = useMemo(
    () => new Set(channels.filter((channel) => channel.canView).map((channel) => channel.id)),
    [channels]
  );
  const jumpToForwarded = useCallback((messageId: string, channelId?: string): boolean => {
    if (jumpToMessage(messageId)) {
      pendingJump.current = null;
      return true;
    }
    if (channelId && channelId !== selectedChannelId.current) {
      pendingJump.current = messageId;
      onSelectChannel(channelId);
    }
    return false;
  }, [onSelectChannel, selectedChannelId]);

  useEffect(() => {
    const pending = pendingJump.current;
    if (pending && jumpToMessage(pending)) pendingJump.current = null;
  }, [history.messages]);

  function openForward(kind: MessageScope, message: MessageView): void {
    const id = kind === "channel" ? message.channelId : message.conversationId;
    if (id !== null) setForward({ source: { kind, id }, message });
  }

  async function forwardMessage(target: ForwardDestination): Promise<void> {
    if (!forward || !composer.csrfToken) throw new Error("Не удалось подготовить защищённый запрос");
    try {
      const request = target.kind === "channel" ? forwardMessageToChannel : forwardMessageToConversation;
      const message = await request(forward.source, forward.message.id, target.id, composer.csrfToken);
      if (!active.current) return;
      onForwarded(message);
    } catch (error) {
      if (active.current && error instanceof ApiError && error.status === 401) onSessionExpired();
      throw error;
    }
    setForward(null);
    setForwardAnnouncement(target.kind === "channel"
      ? `Сообщение переслано в канал «${channels.find((channel) => channel.id === target.id)?.name ?? ""}».`
      : "Сообщение переслано.");
  }

  const channel = scope?.kind === "channel" ? scope.channel : null;
  const channelPanels = scope?.kind === "channel" && (
    <>
      {scope.channel.canView && (
        <PinnedMessagesPanel
          open={pins.open}
          onClose={() => pins.setOpen(false)}
          channelId={scope.channel.id}
          canManageMessages={scope.channel.canManageMessages}
          currentUserId={currentUserId}
          pinnedMessageIds={pins.messageIds}
          onUnpin={(messageId) => pins.changePinned(messageId, false)}
          onJumpToMessage={jumpToMessage}
          timeZone={format.timeZone}
          theme={format.theme}
          onSessionExpired={onSessionExpired}
        />
      )}
      {scope.revokedReason !== null && <RevokedAccessCard reason={scope.revokedReason} onBack={onLeaveRevokedChannel} />}
      <MessageReadersModal
        open={readers !== null}
        onClose={() => setReaders(null)}
        channelId={readers?.channelId ?? ""}
        messageId={readers?.messageId ?? ""}
        timeZone={format.timeZone}
        onSessionExpired={onSessionExpired}
      />
    </>
  );

  return (
    <div className="workspace-content" inert={inactive}>
      <div className="chat-pane">
        <section className="settings-card workspace-message-panel" aria-labelledby="workspace-messages-title">
          {scope?.kind === "conversation" ? (
            <header className="chat-pane-header">
              <DmHeader conversation={scope.conversation} currentUserId={currentUserId} />
            </header>
          ) : (
            <ChannelChatHeading
              channel={channel}
              pinsOpen={pins.open}
              topicExpanded={topicExpanded}
              openPins={() => pins.setOpen(true)}
              toggleTopic={onToggleTopic}
              openProperties={onOpenProperties}
            />
          )}
          {accessDenied && (
            <p className="channel-access-hint" role="status" aria-live="polite">Нет доступа к этому каналу</p>
          )}
          <span className="visually-hidden" aria-live="polite">{dmAnnouncements[0]}</span>
          <span className="visually-hidden" aria-live="polite">{dmAnnouncements[1]}</span>
          {scope ? (
            <ScopedChat
              scope={scope}
              history={history}
              format={format}
              composer={composer}
              actions={actions}
              currentUserId={currentUserId}
              onForward={openForward}
              channelActions={{
                onOpenReaders: (message) => {
                  if (message.channelId !== null) setReaders({ channelId: message.channelId, messageId: message.id });
                },
                isPinned: (messageId) => pins.messageIds.has(messageId),
                onPin: (message) => void pins.changePinned(message.id, true),
                onUnpin: (message) => void pins.changePinned(message.id, false),
                visibleChannelIds,
                onJumpToMessage: jumpToForwarded
              }}
              channelPanels={channelPanels}
            />
          ) : (
            <p className="settings-copy channel-selection-hint">Выберите канал слева, чтобы открыть переписку.</p>
          )}
          {forward && (
            <ForwardMessageDialog
              open
              onClose={() => setForward(null)}
              source={forward.source}
              message={forward.message}
              channels={channels}
              categories={categories}
              conversations={conversations}
              currentUserId={currentUserId}
              onForward={forwardMessage}
              timeZone={format.timeZone}
            />
          )}
          <span className="visually-hidden" aria-live="polite">{forwardAnnouncement}</span>
        </section>
      </div>
    </div>
  );
}
