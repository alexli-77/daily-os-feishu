import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema.js';

/**
 * Echo-guard for the Feishu interaction layer (LEO-202 / H3).
 *
 * The bot used to decide "is this message something I emitted?" purely by
 * matching dozens of hard-coded Chinese outbound-copy prefixes. That logic was
 * duplicated in two call sites and turned every outbound wording change into a
 * potential echo loop (the bot re-processing its own messages).
 *
 * We now decide by SENDER IDENTITY first and only fall back to the old prefix
 * heuristics when identity is genuinely unavailable. See {@link isSelfOriginMessage}
 * for the priority chain.
 */

const DEFAULT_SELF_SENT_TTL_MS = 5 * 60_000;

/**
 * Short-TTL cache of message_ids the interaction layer just emitted.
 *
 * Design decision — bot/user dual identity:
 *   Outbound Feishu messages come from two identities. Messages the bot sends as
 *   itself (SDK / app identity) carry the bot's own open_id, so the identity
 *   check in {@link isSelfOriginMessage} catches those directly. But the
 *   `lark-cli --as user` output path (see src/connectors/lark-cli.ts) sends as
 *   the *owner's own user account*, so those messages come back with the human
 *   owner's open_id — identity alone cannot tell them apart from a message the
 *   human actually typed. For that case we keep this minimal fallback: record the
 *   message_id of anything we emit and compare inbound message_ids against it.
 *   A short TTL is enough because an echo arrives within seconds of the send.
 */
export class SelfSentMessageCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly ttlMs: number = DEFAULT_SELF_SENT_TTL_MS) {}

  record(messageId: string | undefined | null): void {
    if (!messageId) return;
    this.prune();
    this.entries.set(messageId, Date.now() + this.ttlMs);
  }

  has(messageId: string): boolean {
    const expiresAt = this.entries.get(messageId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.entries.delete(messageId);
      return false;
    }
    return true;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }
}

export interface SelfOriginContext {
  /** Open_ids that belong to the bot itself (identity fast-path). */
  botOpenIds: ReadonlySet<string>;
  /** Recently self-emitted message_ids (dual-identity fallback). */
  selfSentMessageIds: Pick<SelfSentMessageCache, 'has'>;
  /**
   * Whether the bot's own identity could be resolved. When false we cannot use
   * the identity fast-path at all, so the legacy prefix heuristics act as a
   * degradation path (and log at debug level).
   */
  identityAvailable: boolean;
}

/**
 * Single source of truth for "did this inbound message originate from us?".
 *
 * Priority chain:
 *   1. Identity — inbound sender open_id is one of the bot's own open_ids.
 *   2. Dual-identity fallback — inbound message_id is in the short-TTL cache of
 *      message_ids we just emitted (covers the `lark-cli --as user` path where
 *      the sender is the human owner, not the bot).
 *   3. Degradation — only when the bot identity could NOT be resolved, fall back
 *      to the legacy outbound-copy prefix heuristics and log at debug level.
 */
export function isSelfOriginMessage(message: NormalizedMessage, ctx: SelfOriginContext): boolean {
  // 1. Identity fast-path.
  if (ctx.botOpenIds.size > 0 && ctx.botOpenIds.has(message.senderId)) return true;

  // 2. Dual-identity fallback via self-sent message_id cache.
  if (ctx.selfSentMessageIds.has(message.messageId)) return true;

  // 3. Degradation path — identity unavailable.
  if (!ctx.identityAvailable) {
    if (isGeneratedDailyOsText(message.content)) {
      console.debug(
        `[interaction] self-origin fell back to prefix heuristics (bot identity unavailable); message=${message.messageId}`,
      );
      return true;
    }
  }

  return false;
}

/**
 * Legacy heuristic: does this text look like outbound Daily OS copy the bot
 * generated? Retained ONLY as the degradation path inside {@link isSelfOriginMessage}
 * for when the bot's own identity cannot be resolved. Prefer identity checks;
 * do not add new call sites.
 */
export function isGeneratedDailyOsText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return (
    normalized.startsWith('收到，我已把这条修改意见写入') ||
    normalized.startsWith('<card title="Daily OS">') ||
    normalized.startsWith('老板，我在后台看了') ||
    normalized.startsWith('Running ') ||
    normalized.startsWith('老板，我帮您') ||
    normalized.startsWith('老板您好') ||
    normalized.startsWith('老板，我把') ||
    normalized.includes('请发送 daily-os weekly，我会按这条意见重新整理') ||
    normalized.includes('请发送 daily-os plan，我会按这条意见重新整理') ||
    normalized.includes('请发送 daily-os review，我会按这条意见重新整理') ||
    normalized.includes('请点卡片里的「重新生成」') ||
    normalized.includes('如果下周安排要改，直接回复') ||
    normalized.includes('您看下周先按这个节奏走可以吗？')
  );
}

/**
 * Resolves the bot's own open_id(s) and owns the self-sent message_id cache.
 *
 * Identity resolution priority (highest first):
 *   1. Explicit config: `interaction.feishu.self.bot_open_ids`.
 *   2. Env override: the open_id(s) in `interaction.feishu.self.bot_open_id_env`
 *      (comma-separated allowed).
 *   3. SDK-resolved identity: `channel.botIdentity.openId` — the SDK populates
 *      this on `connect()` via `/open-apis/bot/v3/info`.
 *   4. Lazy last resort: call `/open-apis/bot/v3/info` directly.
 */
export class SelfOriginGuard {
  private readonly botOpenIds = new Set<string>();
  private readonly selfSent = new SelfSentMessageCache();
  private resolved = false;

  constructor(
    private readonly config: AppConfig,
    private readonly channel: LarkChannel,
  ) {}

  async resolve(): Promise<void> {
    const self = this.config.interaction.feishu.self;

    for (const id of self.bot_open_ids) this.addOpenId(id);

    const envValue = self.bot_open_id_env ? process.env[self.bot_open_id_env] : undefined;
    if (envValue) for (const id of envValue.split(',')) this.addOpenId(id);

    if (this.botOpenIds.size === 0) this.addOpenId(this.channel.botIdentity?.openId);

    if (this.botOpenIds.size === 0) {
      try {
        const response = (await this.channel.rawClient.request({
          url: '/open-apis/bot/v3/info',
          method: 'GET',
        })) as { bot?: { open_id?: string } };
        this.addOpenId(response.bot?.open_id);
      } catch (error) {
        console.warn(
          `[interaction] could not resolve bot open_id for self-origin guard: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.resolved = this.botOpenIds.size > 0;
    if (this.resolved) {
      console.log(`[interaction] self-origin guard using bot identity: ${[...this.botOpenIds].map((id) => id.slice(-6)).join(',')}`);
    } else {
      console.warn('[interaction] self-origin guard has no bot identity; using prefix-heuristic degradation path.');
    }
  }

  context(): SelfOriginContext {
    return {
      botOpenIds: this.botOpenIds,
      selfSentMessageIds: this.selfSent,
      identityAvailable: this.resolved,
    };
  }

  isSelfOrigin(message: NormalizedMessage): boolean {
    return isSelfOriginMessage(message, this.context());
  }

  recordSelfSent(messageId: string | undefined | null): void {
    this.selfSent.record(messageId);
  }

  private addOpenId(id: string | undefined | null): void {
    const trimmed = id?.trim();
    if (trimmed) this.botOpenIds.add(trimmed);
  }
}
