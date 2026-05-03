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

type DateBucket = "today" | "yesterday" | "thisWeek" | "older";
const BUCKET_LABEL: Record<DateBucket, string> = {
	today: "Today",
	yesterday: "Yesterday",
	thisWeek: "This week",
	older: "Older",
};
const BUCKET_ORDER: DateBucket[] = [
	"today",
	"yesterday",
	"thisWeek",
	"older",
];

function bucketForDate(date: Date | null): DateBucket {
	if (!date) return "older";
	const now = new Date();
	const startOfToday = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
	).getTime();
	const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
	const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;
	const t = date.getTime();
	if (t >= startOfToday) return "today";
	if (t >= startOfYesterday) return "yesterday";
	if (t >= startOfWeek) return "thisWeek";
	return "older";
}

function ConversationListPanel({ plugin }: { plugin: AgentClientPlugin }) {
	const [sessions, setSessions] = useState<SavedSessionInfo[]>(
		plugin.settings.savedSessions ?? [],
	);
	const [pinnedIds, setPinnedIds] = useState<Set<string>>(
		new Set(plugin.settings.pinnedSessionIds ?? []),
	);
	const [searchQuery, setSearchQuery] = useState("");
	// sessionId of the conversation currently shown in the focused chat
	// tab. Drives the active-row highlight in the list.
	const [activeSessionId, setActiveSessionId] = useState<string | null>(
		null,
	);

	const computeActiveSessionId = useCallback((): string | null => {
		const focusedId = plugin.viewRegistry.getFocusedId();
		const clients = plugin.getAcpClients();
		if (!focusedId) {
			// Fallback: first chat view's session if any
			const firstClient = clients.values().next().value;
			return firstClient?.getCurrentSessionId?.() ?? null;
		}
		const client = plugin.getAcpClient(focusedId);
		return client?.getCurrentSessionId?.() ?? null;
	}, [plugin]);

	// Refresh when settings change OR active leaf changes. Poll as a
	// fallback for state changes Obsidian doesn't surface as events.
	useEffect(() => {
		const refresh = () => {
			setSessions([...(plugin.settings.savedSessions ?? [])]);
			setPinnedIds(new Set(plugin.settings.pinnedSessionIds ?? []));
			setActiveSessionId(computeActiveSessionId());
		};
		refresh();
		const interval = window.setInterval(refresh, 1500);
		const onFocus = () => refresh();
		window.addEventListener("focus", onFocus);
		const evt = plugin.app.workspace.on("active-leaf-change", refresh);
		return () => {
			window.clearInterval(interval);
			window.removeEventListener("focus", onFocus);
			plugin.app.workspace.offref(evt);
		};
	}, [plugin, computeActiveSessionId]);

	// Group conversations into Pinned section + date buckets (Today /
	// Yesterday / This week / Older). Each group sorts by updatedAt desc.
	const groupedSections = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		const filtered = q
			? sessions.filter((s) =>
					(s.title ?? "").toLowerCase().includes(q),
				)
			: sessions;

		const pinned: SavedSessionInfo[] = [];
		const buckets: Record<DateBucket, SavedSessionInfo[]> = {
			today: [],
			yesterday: [],
			thisWeek: [],
			older: [],
		};

		for (const s of filtered) {
			if (pinnedIds.has(s.sessionId)) {
				pinned.push(s);
				continue;
			}
			const date = s.updatedAt
				? new Date(Date.parse(s.updatedAt))
				: null;
			buckets[bucketForDate(date)].push(s);
		}

		const sortByRecent = (
			a: SavedSessionInfo,
			b: SavedSessionInfo,
		) => {
			const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
			const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
			return bTime - aTime;
		};
		pinned.sort(sortByRecent);
		for (const bucket of BUCKET_ORDER) buckets[bucket].sort(sortByRecent);

		const sections: Array<{
			key: string;
			label: string;
			items: SavedSessionInfo[];
		}> = [];
		if (pinned.length > 0) {
			sections.push({ key: "pinned", label: "Pinned", items: pinned });
		}
		for (const bucket of BUCKET_ORDER) {
			if (buckets[bucket].length > 0) {
				sections.push({
					key: bucket,
					label: BUCKET_LABEL[bucket],
					items: buckets[bucket],
				});
			}
		}
		return sections;
	}, [sessions, pinnedIds, searchQuery]);

	const handleClickSession = useCallback(
		async (session: SavedSessionInfo) => {
			// Default click semantics: open in new tab if not already open,
			// else focus the tab that has it. Browser/IDE pattern — never
			// loses the user's current chat by replacing it.
			await plugin.openConversationInTab(
				session.sessionId,
				session.cwd,
				session.agentId,
			);
		},
		[plugin],
	);

	const handleOpenInCurrentTab = useCallback(
		async (session: SavedSessionInfo) => {
			await plugin.openConversationInCurrentTab(
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

	// Cmd/Ctrl+F focuses search input when panel has focus
	const panelRef = useRef<HTMLDivElement>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (
				(e.ctrlKey || e.metaKey) &&
				e.key.toLowerCase() === "f" &&
				panelRef.current?.contains(document.activeElement)
			) {
				e.preventDefault();
				searchInputRef.current?.focus();
				searchInputRef.current?.select();
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, []);

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
				{groupedSections.length === 0 && (
					<div className="agent-client-conversation-list-empty">
						{searchQuery
							? "No conversations match your search."
							: "No saved conversations yet."}
					</div>
				)}
				{groupedSections.map((section) => (
					<div
						key={section.key}
						className="agent-client-conversation-list-section"
					>
						<div className="agent-client-conversation-list-section-header">
							{section.label}
						</div>
						{section.items.map((session) => (
							<ConversationListItem
								key={session.sessionId}
								session={session}
								isPinned={pinnedIds.has(session.sessionId)}
								isActive={
									activeSessionId === session.sessionId
								}
								onClick={() =>
									void handleClickSession(session)
								}
								onTogglePin={() =>
									handleTogglePin(session.sessionId)
								}
								onEditTitle={() => handleEditTitle(session)}
								onOpenInCurrent={() =>
									void handleOpenInCurrentTab(session)
								}
								onFork={() => handleFork(session)}
								onDelete={() => handleDelete(session)}
							/>
						))}
					</div>
				))}
			</div>
		</div>
	);
}

function ConversationListItem({
	session,
	isPinned,
	isActive,
	onClick,
	onTogglePin,
	onEditTitle,
	onOpenInCurrent,
	onFork,
	onDelete,
}: {
	session: SavedSessionInfo;
	isPinned: boolean;
	isActive: boolean;
	onClick: () => void;
	onTogglePin: () => void;
	onEditTitle: () => void;
	onOpenInCurrent: () => void;
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
					.setTitle("Open in current tab")
					.setIcon("arrow-right")
					.onClick(() => onOpenInCurrent()),
			);
			menu.addItem((item) =>
				item
					.setTitle("Fork (new chat)")
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
			onOpenInCurrent,
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

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				onClick();
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				const next = (e.currentTarget.parentElement
					?.nextElementSibling as HTMLElement | null)?.querySelector(
					".agent-client-conversation-list-item",
				) as HTMLElement | null;
				const sibling =
					(e.currentTarget
						.nextElementSibling as HTMLElement | null) ?? next;
				sibling?.focus?.();
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				const prev = e.currentTarget
					.previousElementSibling as HTMLElement | null;
				if (
					prev &&
					prev.classList.contains(
						"agent-client-conversation-list-item",
					)
				) {
					prev.focus();
				} else {
					// Top of section — try previous section's last item
					const prevSection = e.currentTarget.parentElement
						?.previousElementSibling as HTMLElement | null;
					const items = prevSection?.querySelectorAll(
						".agent-client-conversation-list-item",
					);
					const last = items?.[items.length - 1] as
						| HTMLElement
						| undefined;
					if (last) {
						last.focus();
					} else {
						// Move focus back to search input
						const search = document.querySelector(
							".agent-client-conversation-list-search-input",
						) as HTMLInputElement | null;
						search?.focus();
					}
				}
			}
		},
		[onClick],
	);

	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			handleShowOverflow(e);
		},
		[handleShowOverflow],
	);

	return (
		<div
			className={`agent-client-conversation-list-item${isPinned ? " agent-client-conversation-list-item-pinned" : ""}${isActive ? " agent-client-conversation-list-item-active" : ""}`}
			onClick={onClick}
			onContextMenu={handleContextMenu}
			onKeyDown={handleKeyDown}
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
