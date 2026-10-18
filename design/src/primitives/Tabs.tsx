import React, { createContext, useContext, useState, useRef } from "react";

interface TabsContextValue {
  value: string;
  setValue: (val: string) => void;
  tabIds: string[];
  registerTab: (val: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  value: controlledValue,
  defaultValue = "",
  onChange,
  children,
  className = "",
}) => {
  const [uncontrolledValue, setUncontrolledValue] = useState<string>(defaultValue);
  const [tabIds, setTabIds] = useState<string[]>([]);

  const isControlled = controlledValue !== undefined;
  const activeValue = isControlled ? controlledValue : uncontrolledValue;

  const setValue = (val: string) => {
    if (!isControlled) {
      setUncontrolledValue(val);
    }
    onChange?.(val);
  };

  const registerTab = (val: string) => {
    setTabIds((prev) => (prev.includes(val) ? prev : [...prev, val]));
  };

  return (
    <TabsContext.Provider value={{ value: activeValue, setValue, tabIds, registerTab }}>
      <div className={`obs-tabs ${className}`.trim()}>{children}</div>
    </TabsContext.Provider>
  );
};

export interface TabListProps {
  "aria-label"?: string;
  children: React.ReactNode;
  className?: string;
}

export const TabList: React.FC<TabListProps> = ({
  "aria-label": ariaLabel,
  children,
  className = "",
}) => {
  const listRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') || []
    );
    if (!tabs.length) return;

    const currentIndex = tabs.findIndex((t) => t === document.activeElement);
    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (e.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabs.length;
      e.preventDefault();
    } else if (e.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      e.preventDefault();
    } else if (e.key === "Home") {
      nextIndex = 0;
      e.preventDefault();
    } else if (e.key === "End") {
      nextIndex = tabs.length - 1;
      e.preventDefault();
    }

    if (nextIndex !== currentIndex) {
      tabs[nextIndex].focus();
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`obs-tab-list ${className}`.trim()}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
};

export interface TabProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onClick" | "role" | "type" | "id"> {
  value: string;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}

export const Tab: React.FC<TabProps> = ({
  value,
  disabled = false,
  children,
  className = "",
  ...rest
}) => {
  const context = useContext(TabsContext);
  if (!context) throw new Error("Tab must be used within Tabs");

  const { value: activeValue, setValue, registerTab } = context;

  React.useEffect(() => {
    registerTab(value);
  }, [value, registerTab]);

  const isSelected = activeValue === value;

  return (
    <button
      {...rest}
      role="tab"
      type="button"
      id={`tab-${value}`}
      aria-controls={`panel-${value}`}
      aria-selected={isSelected}
      tabIndex={isSelected ? 0 : -1}
      disabled={disabled}
      className={`obs-tab ${className}`.trim()}
      onClick={() => setValue(value)}
    >
      {children}
    </button>
  );
};

export interface TabPanelProps {
  value: string;
  children: React.ReactNode;
  className?: string;
}

export const TabPanel: React.FC<TabPanelProps> = ({
  value,
  children,
  className = "",
}) => {
  const context = useContext(TabsContext);
  if (!context) throw new Error("TabPanel must be used within Tabs");

  const isSelected = context.value === value;
  if (!isSelected) return null;

  return (
    <div
      role="tabpanel"
      id={`panel-${value}`}
      aria-labelledby={`tab-${value}`}
      tabIndex={0}
      className={`obs-tab-panel ${className}`.trim()}
    >
      {children}
    </div>
  );
};
