import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  Button,
  IconButton,
  Panel,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  List,
  ListItem,
  Badge,
  Tooltip,
  Dialog,
  TextField,
  Toggle,
  Kbd,
} from "../src";

describe("Observatory React Primitives", () => {
  describe("Button", () => {
    it("renders with label and fires onClick", async () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>Activate</Button>);
      const btn = screen.getByRole("button", { name: "Activate" });
      expect(btn).toBeInTheDocument();
      await userEvent.click(btn);
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it("supports keyboard focus and activation", async () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>Focus Target</Button>);
      const btn = screen.getByRole("button", { name: "Focus Target" });
      btn.focus();
      expect(btn).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(handleClick).toHaveBeenCalledTimes(1);
      await userEvent.keyboard(" ");
      expect(handleClick).toHaveBeenCalledTimes(2);
    });

    it("respects disabled state and aria-disabled", async () => {
      const handleClick = vi.fn();
      render(
        <Button disabled onClick={handleClick}>
          Disabled Button
        </Button>
      );
      const btn = screen.getByRole("button", { name: "Disabled Button" });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(btn);
      expect(handleClick).not.toHaveBeenCalled();
    });

    it("applies variant classes", () => {
      const { rerender } = render(<Button variant="gilt">Gilt</Button>);
      expect(screen.getByRole("button")).toHaveClass("obs-button--gilt");

      rerender(<Button variant="destructive">Destructive</Button>);
      expect(screen.getByRole("button")).toHaveClass("obs-button--destructive");

      rerender(<Button variant="ghost">Ghost</Button>);
      expect(screen.getByRole("button")).toHaveClass("obs-button--ghost");
    });
  });

  describe("IconButton", () => {
    it("renders with accessible aria-label", async () => {
      const handleClick = vi.fn();
      render(
        <IconButton
          aria-label="Celestial Settings"
          onClick={handleClick}
        >
          <svg data-testid="icon" viewBox="0 0 16 16" />
        </IconButton>
      );
      const btn = screen.getByRole("button", { name: "Celestial Settings" });
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveAttribute("aria-label", "Celestial Settings");
      await userEvent.click(btn);
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it("supports keyboard focus", () => {
      render(
        <IconButton aria-label="Search Observatory">
          <span>*</span>
        </IconButton>
      );
      const btn = screen.getByRole("button", { name: "Search Observatory" });
      btn.focus();
      expect(btn).toHaveFocus();
    });
  });

  describe("Panel", () => {
    it("renders children with observatory panel styles", () => {
      render(
        <Panel title="Solar System">
          <p>Inner content</p>
        </Panel>
      );
      expect(screen.getByText("Solar System")).toBeInTheDocument();
      expect(screen.getByText("Inner content")).toBeInTheDocument();
      const region = screen.getByRole("region", { name: "Solar System" });
      expect(region).toHaveClass("obs-panel");
    });

    it("supports raised variant and custom header/footer", () => {
      render(
        <Panel
          variant="raised"
          header={<div>Header Node</div>}
          footer={<div>Footer Node</div>}
        >
          Body
        </Panel>
      );
      expect(screen.getByText("Header Node")).toBeInTheDocument();
      expect(screen.getByText("Footer Node")).toBeInTheDocument();
      expect(screen.getByText("Body").closest(".obs-panel")).toHaveClass(
        "obs-panel--raised"
      );
    });
  });

  describe("Tabs", () => {
    it("renders tabs and controls active panel with correct ARIA roles", async () => {
      render(
        <Tabs defaultValue="almanac">
          <TabList aria-label="Observatory Views">
            <Tab value="orrery">Orrery</Tab>
            <Tab value="almanac">Almanac</Tab>
          </TabList>
          <TabPanel value="orrery">Orrery Content</TabPanel>
          <TabPanel value="almanac">Almanac Content</TabPanel>
        </Tabs>
      );

      const tabList = screen.getByRole("tablist", {
        name: "Observatory Views",
      });
      expect(tabList).toBeInTheDocument();

      const orreryTab = screen.getByRole("tab", { name: "Orrery" });
      const almanacTab = screen.getByRole("tab", { name: "Almanac" });

      expect(almanacTab).toHaveAttribute("aria-selected", "true");
      expect(orreryTab).toHaveAttribute("aria-selected", "false");
      expect(screen.getByText("Almanac Content")).toBeVisible();

      await userEvent.click(orreryTab);
      expect(orreryTab).toHaveAttribute("aria-selected", "true");
      expect(almanacTab).toHaveAttribute("aria-selected", "false");
      expect(screen.getByText("Orrery Content")).toBeVisible();
    });

    it("supports keyboard arrow navigation between tabs", async () => {
      render(
        <Tabs defaultValue="tab1">
          <TabList aria-label="Demo Tabs">
            <Tab value="tab1">Tab 1</Tab>
            <Tab value="tab2">Tab 2</Tab>
            <Tab value="tab3">Tab 3</Tab>
          </TabList>
          <TabPanel value="tab1">Panel 1</TabPanel>
          <TabPanel value="tab2">Panel 2</TabPanel>
          <TabPanel value="tab3">Panel 3</TabPanel>
        </Tabs>
      );

      const tab1 = screen.getByRole("tab", { name: "Tab 1" });
      const tab2 = screen.getByRole("tab", { name: "Tab 2" });
      tab1.focus();
      expect(tab1).toHaveFocus();

      fireEvent.keyDown(tab1, { key: "ArrowRight" });
      expect(tab2).toHaveFocus();
    });
  });

  describe("List and ListItem", () => {
    it("renders list and items with correct roles and selection", async () => {
      const handleSelect = vi.fn();
      render(
        <List aria-label="Agent Sessions">
          <ListItem id="s1" selected onClick={() => handleSelect("s1")}>
            Session 1
          </ListItem>
          <ListItem id="s2" onClick={() => handleSelect("s2")}>
            Session 2
          </ListItem>
        </List>
      );

      const list = screen.getByRole("list", { name: "Agent Sessions" });
      expect(list).toBeInTheDocument();

      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveAttribute("aria-selected", "true");
      expect(items[1]).toHaveAttribute("aria-selected", "false");

      await userEvent.click(items[1]);
      expect(handleSelect).toHaveBeenCalledWith("s2");
    });
  });

  describe("Badge", () => {
    it("renders text and applies status variants", () => {
      const { rerender } = render(<Badge variant="verdigris">Active</Badge>);
      const badge = screen.getByText("Active");
      expect(badge).toHaveClass("obs-badge--verdigris");

      rerender(<Badge variant="vermilion">Needs You</Badge>);
      expect(screen.getByText("Needs You")).toHaveClass("obs-badge--vermilion");

      rerender(<Badge variant="gilt">Observatory Pass</Badge>);
      expect(screen.getByText("Observatory Pass")).toHaveClass(
        "obs-badge--gilt"
      );
    });
  });

  describe("Tooltip", () => {
    it("reveals content on hover and focus and associates aria-describedby", async () => {
      render(
        <Tooltip content="Orbit period: 60s">
          <button>Hover Planet</button>
        </Tooltip>
      );

      const trigger = screen.getByRole("button", { name: "Hover Planet" });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      await userEvent.hover(trigger);
      const tip = await screen.findByRole("tooltip");
      expect(tip).toHaveTextContent("Orbit period: 60s");
      expect(trigger).toHaveAttribute("aria-describedby", tip.id);

      await userEvent.unhover(trigger);
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("displays on keyboard focus and closes on Escape", async () => {
      render(
        <Tooltip content="Gilt hairline accent">
          <button>Focus Key</button>
        </Tooltip>
      );

      const trigger = screen.getByRole("button", { name: "Focus Key" });
      await userEvent.tab();
      expect(trigger).toHaveFocus();
      const tip = await screen.findByRole("tooltip");
      expect(tip).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  describe("Dialog", () => {
    it("renders modal dialog with accessible attributes and close trigger", async () => {
      const handleClose = vi.fn();
      render(
        <Dialog
          isOpen={true}
          onClose={handleClose}
          title="Switchboard Configuration"
        >
          <p>Dialog body content</p>
          <Button onClick={handleClose}>Close</Button>
        </Dialog>
      );

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog).toHaveAttribute("aria-labelledby");
      expect(screen.getByText("Switchboard Configuration")).toBeInTheDocument();
      expect(screen.getByText("Dialog body content")).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(handleClose).toHaveBeenCalled();
    });

    it("traps focus so Tab cannot leave the dialog and wraps around", async () => {
      render(
        <div>
          <button id="outside-before">Outside Before</button>
          <Dialog isOpen={true} onClose={() => {}} title="Trapped Dialog">
            <input aria-label="First Field" defaultValue="1" />
            <button id="inside-btn">Inside Button</button>
          </Dialog>
          <button id="outside-after">Outside After</button>
        </div>
      );

      const closeBtn = screen.getByRole("button", { name: "Close dialog" });
      const insideBtn = screen.getByRole("button", { name: "Inside Button" });

      insideBtn.focus();
      expect(document.activeElement).toBe(insideBtn);

      // Tab from last element wraps to first focusable element (Close button)
      fireEvent.keyDown(insideBtn, { key: "Tab" });
      expect(document.activeElement).toBe(closeBtn);

      // Shift+Tab from closeBtn wraps to last element (insideBtn)
      fireEvent.keyDown(closeBtn, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(insideBtn);
    });

    it("restores focus to the opener element upon closing", async () => {
      const TestWrapper = () => {
        const [open, setOpen] = React.useState(false);
        return (
          <div>
            <button id="opener-btn" onClick={() => setOpen(true)}>
              Open Dialog
            </button>
            <Dialog isOpen={open} onClose={() => setOpen(false)} title="Restoration Dialog">
              <button id="dismiss-btn" onClick={() => setOpen(false)}>
                Dismiss
              </button>
            </Dialog>
          </div>
        );
      };

      render(<TestWrapper />);
      const opener = screen.getByRole("button", { name: "Open Dialog" });
      opener.focus();
      expect(document.activeElement).toBe(opener);

      await userEvent.click(opener);
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      const dismissBtn = screen.getByRole("button", { name: "Dismiss" });
      await userEvent.click(dismissBtn);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(opener);
    });

    it("makes background elements inert while open and restores them upon closing", async () => {
      const TestWrapper = () => {
        const [open, setOpen] = React.useState(false);
        return (
          <div>
            <div id="background-area">
              <button id="bg-button">Background Action</button>
            </div>
            <button id="toggle-dialog" onClick={() => setOpen((prev) => !prev)}>
              Toggle
            </button>
            <Dialog isOpen={open} onClose={() => setOpen(false)} title="Inertness Dialog">
              <p>Content</p>
            </Dialog>
          </div>
        );
      };

      const { container } = render(<TestWrapper />);
      const bgArea = container.querySelector("#background-area") as HTMLElement;
      expect(bgArea.hasAttribute("inert") || (bgArea as any).inert).toBeFalsy();

      const toggle = screen.getByRole("button", { name: "Toggle" });
      await userEvent.click(toggle);

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // Background element must be marked inert and aria-hidden
      expect(bgArea.hasAttribute("inert") || (bgArea as any).inert).toBeTruthy();
      expect(bgArea.getAttribute("aria-hidden")).toBe("true");

      // Close dialog
      await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(bgArea.hasAttribute("inert") || (bgArea as any).inert).toBeFalsy();
      expect(bgArea.getAttribute("aria-hidden")).toBeNull();
    });
  });

  describe("TextField", () => {
    it("renders input, handles typing and keyboard focus", async () => {
      const handleChange = vi.fn();
      render(
        <TextField
          label="Search Archive"
          placeholder="Filter prompts..."
          onChange={handleChange}
        />
      );

      const input = screen.getByLabelText("Search Archive");
      expect(input).toBeInTheDocument();
      input.focus();
      expect(input).toHaveFocus();

      await userEvent.type(input, "test query");
      expect(handleChange).toHaveBeenCalled();
    });

    it("handles error state with aria-invalid", () => {
      render(
        <TextField
          label="Target Path"
          error="Path does not exist"
        />
      );

      const input = screen.getByLabelText("Target Path");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText("Path does not exist")).toBeInTheDocument();
    });
  });

  describe("Toggle", () => {
    it("renders switch, handles toggle click and space key", async () => {
      const handleToggle = vi.fn();
      render(
        <Toggle
          label="Reduced Motion"
          checked={false}
          onChange={handleToggle}
        />
      );

      const toggle = screen.getByRole("switch", { name: "Reduced Motion" });
      expect(toggle).toHaveAttribute("aria-checked", "false");

      await userEvent.click(toggle);
      expect(handleToggle).toHaveBeenCalledWith(true);

      toggle.focus();
      expect(toggle).toHaveFocus();
      await userEvent.keyboard(" ");
      expect(handleToggle).toHaveBeenCalledWith(true);
    });
  });

  describe("Kbd", () => {
    it("renders keyboard shortcut indicator", () => {
      render(
        <p>
          Press <Kbd>Cmd</Kbd> + <Kbd>K</Kbd> to open Search
        </p>
      );
      const kbdElements = screen.getAllByText(/Cmd|K/);
      expect(kbdElements.length).toBeGreaterThanOrEqual(2);
      expect(kbdElements[0].tagName.toLowerCase()).toBe("kbd");
      expect(kbdElements[0]).toHaveClass("obs-kbd");
    });
  });
});
