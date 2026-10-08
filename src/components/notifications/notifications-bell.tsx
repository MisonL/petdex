"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import { Bell } from "lucide-react";

import { useHeaderState } from "@/components/layout/header-state-provider";
import type { NotificationItem } from "@/components/notifications/notifications-panel";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const NotificationsPanel = dynamic(
  () =>
    import("@/components/notifications/notifications-panel").then(
      (mod) => mod.NotificationsPanel,
    ),
  { loading: () => null, ssr: false },
);

export function NotificationsBell({ compact = false }: { compact?: boolean }) {
  const { state, refresh, setUnreadCount } = useHeaderState();
  const unread = state.notifications.unreadCount;
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  const setUnread = useCallback(
    (next: number | ((n: number) => number)) => {
      setUnreadCount(next);
    },
    [setUnreadCount],
  );

  const loadItems = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { items?: NotificationItem[] };
      setItems(j.items ?? []);
      setItemsLoaded(true);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    if (open && !itemsLoaded) void loadItems();
  }, [open, itemsLoaded, loadItems]);

  // Both writers below are optimistic, and `fetch` only rejects on a network
  // failure — a 401/403/500 resolves normally. Without the `res.ok` check the
  // panel kept the optimistic "read" forever: `refresh` reconciles the badge
  // count from the server but never the list, and `itemsLoaded` gates the
  // only re-fetch, so it stayed true and the list was never re-read. The user
  // saw a badge reading 3 above a list with nothing unread, and clicking an
  // item could not retry the write because `isUnread` was already false.
  async function markAll() {
    const previousItems = items;
    const previousUnread = unread;
    setUnread(0);
    setItems((prev) =>
      prev.map((n) =>
        n.readAt ? n : { ...n, readAt: new Date().toISOString() },
      ),
    );
    try {
      const res = await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
    } catch {
      setItems(previousItems);
      setUnread(previousUnread);
      // Let the next open re-read the truth instead of trusting this list.
      setItemsLoaded(false);
    } finally {
      void refresh({ force: true });
    }
  }

  async function markOne(id: string) {
    const previousItems = items;
    const previousUnread = unread;
    setItems((prev) =>
      prev.map((n) =>
        n.id === id && !n.readAt
          ? { ...n, readAt: new Date().toISOString() }
          : n,
      ),
    );
    setUnread((n) => Math.max(0, n - 1));
    try {
      const res = await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
    } catch {
      setItems(previousItems);
      setUnread(previousUnread);
      setItemsLoaded(false);
    } finally {
      void refresh({ force: true });
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              unread > 0 ? `${unread} unread notifications` : "Notifications"
            }
            className={`relative rounded-full border border-border-base bg-surface/70 text-muted-2 backdrop-blur transition-[width,height] duration-200 hover:bg-surface-muted ${compact ? "size-9" : "size-11"}`}
          >
            <Bell className="size-4" />
            {unread > 0 ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-brand font-mono text-[9px] font-semibold text-on-inverse ring-2 ring-white"
              >
                {unread > 9 ? "9+" : unread}
              </span>
            ) : null}
          </Button>
        }
      />

      <PopoverContent
        align="end"
        sideOffset={8}
        className="flex max-h-[min(70vh,520px)] w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border-base bg-surface p-0 shadow-xl shadow-blue-950/15"
      >
        <NotificationsPanel
          items={items}
          onClose={() => setOpen(false)}
          onMarkAll={() => void markAll()}
          onMarkOne={(id) => void markOne(id)}
          unread={unread}
        />
      </PopoverContent>
    </Popover>
  );
}
