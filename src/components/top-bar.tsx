import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export function TopBar({
  sidebarOpen,
  onToggleSidebar,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-card px-3 py-2">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "收合 thread 清單" : "展開 thread 清單"}
        aria-expanded={sidebarOpen}
        aria-controls="thread-sidebar"
      >
        {sidebarOpen ? (
          <PanelLeftCloseIcon aria-hidden="true" />
        ) : (
          <PanelLeftOpenIcon aria-hidden="true" />
        )}
      </Button>
      <div className="flex items-center gap-2 font-semibold">
        <span>Chum Bucket</span>
      </div>
    </header>
  );
}
