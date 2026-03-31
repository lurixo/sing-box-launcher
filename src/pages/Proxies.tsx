import { useState } from "react";
import {
  FlashRegular,
  SearchRegular,
  CheckmarkCircleFilled,
} from "@fluentui/react-icons";
import { useAppStore } from "@/stores/appStore";

function DelayBadge({ delay }: { delay?: number }) {
  if (delay === undefined) return null;
  let cls = "timeout";
  let text = "timeout";
  if (delay > 0 && delay < 200) {
    cls = "fast";
    text = `${delay}ms`;
  } else if (delay >= 200 && delay < 500) {
    cls = "medium";
    text = `${delay}ms`;
  } else if (delay >= 500) {
    cls = "slow";
    text = `${delay}ms`;
  }
  return <span className={`delay-badge ${cls}`}>{text}</span>;
}

export function Proxies() {
  const {
    status,
    groups,
    selectedGroup,
    selectGroup,
    switchProxy,
    testDelay,
    delays,
    testingGroup,
  } = useAppStore();

  const [search, setSearch] = useState("");

  const currentGroup = groups.find((g) => g.name === selectedGroup);
  const groupDelays = selectedGroup ? delays[selectedGroup] : undefined;

  const filteredNodes =
    currentGroup?.all.filter((node) =>
      node.toLowerCase().includes(search.toLowerCase())
    ) ?? [];

  if (!status.running) {
    return (
      <div
        className="animate-in"
        style={{
          padding: "48px 28px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--fluent-text-tertiary)",
          fontSize: 14,
        }}
      >
        Start the core to view proxy groups.
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div
        className="animate-in"
        style={{
          padding: "48px 28px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          color: "var(--fluent-text-tertiary)",
          fontSize: 14,
        }}
      >
        <span className="progress-ring" />
        Loading proxy groups…
      </div>
    );
  }

  return (
    <div className="animate-in" style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Group List */}
      <div
        style={{
          width: 180,
          flexShrink: 0,
          borderRight: "1px solid var(--fluent-border-divider)",
          display: "flex",
          flexDirection: "column",
          padding: "12px 6px",
          gap: 2,
          overflowY: "auto",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--fluent-text-secondary)",
            padding: "4px 10px 8px",
          }}
        >
          Groups ({groups.length})
        </div>
        {groups.map((g) => (
          <button
            key={g.name}
            className={`nav-item ${selectedGroup === g.name ? "active" : ""}`}
            onClick={() => selectGroup(g.name)}
            style={{ fontSize: 13 }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {g.name}
            </span>
          </button>
        ))}
      </div>

      {/* Node List */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 16px",
            borderBottom: "1px solid var(--fluent-border-divider)",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flex: 1,
              background: "var(--fluent-bg-card)",
              border: "1px solid var(--fluent-border-default)",
              borderRadius: "var(--radius-sm)",
              padding: "4px 10px",
            }}
          >
            <SearchRegular style={{ fontSize: 16, color: "var(--fluent-text-tertiary)" }} />
            <input
              type="text"
              placeholder="Search nodes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                border: "none",
                background: "transparent",
                outline: "none",
                color: "var(--fluent-text-primary)",
                fontSize: 13,
                flex: 1,
                fontFamily: "inherit",
              }}
            />
          </div>
          <button
            className="fluent-btn"
            onClick={() => selectedGroup && testDelay(selectedGroup)}
            disabled={testingGroup !== null || !selectedGroup}
            style={{ fontSize: 13, whiteSpace: "nowrap" }}
          >
            {testingGroup === selectedGroup ? (
              <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
            ) : (
              <FlashRegular style={{ fontSize: 16 }} />
            )}
            Test All
          </button>
        </div>

        {/* Current selection info */}
        {currentGroup && (
          <div
            style={{
              padding: "8px 16px",
              fontSize: 12,
              color: "var(--fluent-text-secondary)",
              flexShrink: 0,
            }}
          >
            <strong style={{ color: "var(--fluent-text-primary)" }}>
              {currentGroup.name}
            </strong>
            {" · "}
            {filteredNodes.length} nodes
            {currentGroup.now && (
              <>
                {" · Selected: "}
                <span style={{ color: "var(--color-accent)" }}>{currentGroup.now}</span>
              </>
            )}
          </div>
        )}

        {/* Nodes grid */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 16px 16px",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: 8,
            }}
          >
            {filteredNodes.map((node) => {
              const isSelected = node === currentGroup?.now;
              const delay = groupDelays?.[node];
              return (
                <div
                  key={node}
                  className={`node-card ${isSelected ? "selected" : ""}`}
                  onClick={() =>
                    currentGroup && switchProxy(currentGroup.name, node)
                  }
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      currentGroup && switchProxy(currentGroup.name, node);
                    }
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {isSelected && (
                      <CheckmarkCircleFilled
                        style={{ fontSize: 16, color: "var(--color-accent)", flexShrink: 0 }}
                      />
                    )}
                    <span
                      style={{
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {node}
                    </span>
                  </div>
                  <DelayBadge delay={delay} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
