/**
 * Conversation List View — persistent Slack-style session switcher.
 *
 * Renders all saved conversations as a list in its own Obsidian pane.
 * Click a conversation → restore it in the active chat view (or open a
 * new chat tab if none active). Pinned sessions sort to top. Search
 * filters by title. New-chat button at the top opens a fresh chat tab.
 */

import { ItemView, WorkspaceLeaf, setIcon, Notice, Menu } from "obsidian";
import * as React from "react";
const { useState, useEffect, useMemo, useRef, useCallback } = React;
import { createRoot, Root } from "react-dom/client";

import type AgentClientPlugin from "../plugin";
import type { SavedSessionInfo } from "../types/session";
import { VIEW_TYPE_CHAT } from "./ChatView";
import { EditTitleModal, ConfirmDeleteModal } from "./SessionHistoryModal";

export const VIEW_TYPE_CONVERSATION_LIST =
	"agent-client-conversation-list-view";

function formatRelativeTime(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins} min ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays === 1) return "yesterday";
	if (diffDays < 7) return `${diffDays} days ago`;
	return date.toLocaleDateString();
}

function ConversationListPanel({ plugin }: { plugin: AgentClientPlugin }) {
	const [sessions, setSessions] = useState<SavedSessionInfo[]>(
		plugin.settings.savedSessions ?? [],
	);
	const [pinnedIds, setPinnedIds] = useState<Set<string>>(
		new Set(plugin.settings.pinnedSessionIds ?? []),
	);
	const [searchQuery, setSearchQuery] = useState("");

	// Refresh when settings change (poll lightly — Obsidian doesn't expose
	// a settings-change event for plugin settings, so we re-read on focus).
	useEffect(() => {
		const refresh = () => {
			setSessions([...(plugin.settings.savedSessions ?? [])]);
			setPinnedIds(new Set(plugin.settings.pinnedSessionIds ?? []));
		};
		const interval = window.setInterval(refresh, 1500);
		const onFocus = () => refresh();
		window.addEventListener("focus", onFocus);
		return () => {
			window.clearInterval(interval);
			window.removeEventListener("focus", onFocus);
		};
	}, [plugin]);

	const filteredAndSorted = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		const filtered = q
			? sessions.filter((s) =>
					(s.title ?? "").toLowerCase().includes(q),
				)
			: sessions;
		// Pinned first, then by lastUpdated descending
		return [...filtered].sort((a, b) => {
			const aPinned = pinnedIds.has(a.sessionId);
			const bPinned = pinnedIds.has(b.sessionId);
			if (aPinned !== bPinned) return aPinned ? -1 : 1;
			const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
			const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
			return bTime - aTime;
		});
	}, [sessions, pinnedIds, searchQuery]);

	const handleClickSession = useCallback(
		async (session: SavedSessionInfo) => {
			await plugin.restoreSessionInActiveOrNewChatView(
				session.sessionId,
				session.cwd,
				session.agentId,
			);
		},
		[plugin],
	);

	const handleNewChat = useCallback(() => {
		void plugin.openNewChatViewWithAgent(plugin.settings.defaultAgentId);
	}, [plugin]);

	const handleTogglePin = useCallback(
		(sessionId: string) => {
			const ids = new Set(plugin.settings.pinnedSessionIds ?? []);
			if (ids.has(sessionId)) ids.delete(sessionId);
			else ids.add(sessionId);
			plugin.settings.pinnedSessionIds = Array.from(ids);
			void plugin.saveSettings();
			setPinnedIds(new Set(ids));
		},
		[plugin],
	);

	const handleEditTitle = useCallback(
		(session: SavedSessionInfo) => {
			const modal = new EditTitleModal(
				plugin.app,
				session.title ?? "Untitled",
				async (newTitle) => {
					const idx = (plugin.settings.savedSessions ?? []).findIndex(
						(s) => s.sessionId === session.sessionId,
					);
					if (idx >= 0) {
						plugin.settings.savedSessions[idx] = {
							...plugin.settings.savedSessions[idx],
							title: newTitle,
						};
						await plugin.saveSettings();
						setSessions([...plugin.settings.savedSessions]);
					}
				},
			);
			modal.open();
		},
		[plugin],
	);

	const handleDelete = useCallback(
		(session: SavedSessionInfo) => {
			const modal = new ConfirmDeleteModal(
				plugin.app,
				session.title ?? "Untitled",
				async () => {
					plugin.settings.savedSessions = (
						plugin.settings.savedSessions ?? []
					).filter((s) => s.sessionId !== session.sessionId);
					// Also unpin if pinned
					plugin.settings.pinnedSessionIds = (
						plugin.settings.pinnedSessionIds ?? []
					).filter((id) => id !== session.sessionId);
					await plugin.saveSettings();
					setSessions([...plugin.settings.savedSessions]);
					setPinnedIds(
						new Set(plugin.settings.pinnedSessionIds),
					);
					new Notice(
						`[Agent Client] Removed "${session.title ?? "session"}" from list`,
					);
				},
			);
			modal.open();
		},
		[plugin],
	);

	const handleFork = useCallback(
		(_session: SavedSessionInfo) => {
			// Fork requires a running ACP session via the agent's
			// session/fork RPC, which the side panel doesn't have its own
			// connection for. Route through openNewChatViewWithAgent for now
			// (fresh tab with same agent). True fork-from-this-session is
			// a follow-up that requires plugin-level helper into the
			// agent's loadSession-then-fork flow.
			void plugin.openNewChatViewWithAgent(
				plugin.settings.defaultAgentId,
			);
			new Notice(
				"[Agent Client] Opened new chat tab (true fork TBD)",
			);
		},
		[plugin],
	);

	const searchIconRef = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (searchIconRef.current)
			setIcon(searchIconRef.current, "search");
	}, []);
	const newChatIconRef = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (newChatIconRef.current) setIcon(newChatIconRef.current, "plus");
	}, []);

	return (
		<div className="agent-client-conversation-list-panel">
			<div className="agent-client-conversation-list-header">
				<button
					type="button"
					className="agent-client-conversation-list-new-chat"
					onClick={handleNewChat}
					title="Start a new conversation"
				>
					<span ref={newChatIconRef} aria-hidden="true" />
					<span>New chat</span>
				</button>
			</div>
			<div className="agent-client-conversation-list-search">
				<span
					ref={searchIconRef}
					className="agent-client-conversation-list-search-icon"
					aria-hidden="true"
				/>
				<input
					type="text"
					className="agent-client-conversation-list-search-input"
					placeholder="Search conversations..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
				/>
			</div>
			<div className="agent-client-conversation-list-items">
				{filteredAndSorted.length === 0 && (
					<div className="agent-client-conversation-list-empty">
						{searchQuery
							? "No conversations match your search."
							: "No saved conversations yet."}
					</div>
				)}
				{filteredAndSorted.map((session) => (
					<ConversationListItem
						key={session.sessionId}
						session={session}
						isPinned={pinnedIds.has(session.sessionId)}
						onClick={() => void handleClickSession(session)}
						onTogglePin={() => handleTogglePin(session.sessionId)}
						onEditTitle={() => handleEditTitle(session)}
						onRestore={() => void handleClickSession(session)}
						onFork={() => handleFork(session)}
						onDelete={() => handleDelete(session)}
					/>
				))}
			</div>
		</div>
	);
}

function ConversationListItem({
	session,
	isPinned,
	onClick,
	onTogglePin,
	onEditTitle,
	onRestore,
	onFork,
	onDelete,
}: {
	session: SavedSessionInfo;
	isPinned: boolean;
	onClick: () => void;
	onTogglePin: () => void;
	onEditTitle: () => void;
	onRestore: () => void;
	onFork: () => void;
	onDelete: () => void;
}) {
	const pinIconRef = useRef<HTMLSpanElement>(null);
	const moreIconRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (pinIconRef.current)
			setIcon(pinIconRef.current, isPinned ? "pin-off" : "pin");
	}, [isPinned]);
	useEffect(() => {
		if (moreIconRef.current)
			setIcon(moreIconRef.current, "more-vertical");
	}, []);

	const lastUpdated = session.updatedAt
		? formatRelativeTime(new Date(Date.parse(session.updatedAt)))
		: "";

	const handleShowOverflow = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle(isPinned ? "Unpin" : "Pin")
					.setIcon(isPinned ? "pin-off" : "pin")
					.onClick(() => onTogglePin()),
			);
			menu.addItem((item) =>
				item
					.setTitle("Rename")
					.setIcon("pencil")
					.onClick(() => onEditTitle()),
			);
			menu.addItem((item) =>
				item
					.setTitle("Restore in active chat")
					.setIcon("play")
					.onClick(() => onRestore()),
			);
			menu.addItem((item) =>
				item
					.setTitle("Fork (open in new chat)")
					.setIcon("git-branch")
					.onClick(() => onFork()),
			);
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Delete")
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => onDelete()),
			);
			menu.showAtMouseEvent(e.nativeEvent);
		},
		[
			isPinned,
			onTogglePin,
			onEditTitle,
			onRestore,
			onFork,
			onDelete,
		],
	);

	const handleTogglePinClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onTogglePin();
		},
		[onTogglePin],
	);

	return (
		<div
			className={`agent-client-conversation-list-item${isPinned ? " agent-client-conversation-list-item-pinned" : ""}`}
			onClick={onClick}
			role="button"
			tabIndex={0}
		>
			<div className="agent-client-conversation-list-item-content">
				<div className="agent-client-conversation-list-item-title">
					<span>{session.title ?? "Untitled"}</span>
				</div>
				{lastUpdated && (
					<div className="agent-client-conversation-list-item-meta">
						{lastUpdated}
					</div>
				)}
			</div>
			<div className="agent-client-conversation-list-item-actions">
				{/* Pin stays inline when pinned (most common quick action).
				    Otherwise hidden — accessible via the overflow menu. */}
				{isPinned && (
					<button
						type="button"
						className="agent-client-conversation-list-item-action agent-client-conversation-list-item-action-pin-active"
						onClick={handleTogglePinClick}
						title="Unpin conversation"
					>
						<span ref={pinIconRef} aria-hidden="true" />
					</button>
				)}
				<button
					type="button"
					className="agent-client-conversation-list-item-action agent-client-conversation-list-item-action-overflow"
					onClick={handleShowOverflow}
					title="More actions"
				>
					<span ref={moreIconRef} aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}

export class ConversationListView extends ItemView {
	private root: Root | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: AgentClientPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_CONVERSATION_LIST;
	}

	getDisplayText() {
		return "Conversations";
	}

	getIcon() {
		return "messages-square";
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("agent-client-conversation-list-container");
		this.root = createRoot(container);
		this.root.render(
			React.createElement(ConversationListPanel, {
				plugin: this.plugin,
			}),
		);
	}

	async onClose() {
		if (this.root) {
			this.root.unmount();
			this.root = null;
		}
	}
}
