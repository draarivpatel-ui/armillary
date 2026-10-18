import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  Select,
  Checkbox,
  SegmentedControl,
  FilterChip,
  Figure,
  FigureGroup,
  Mark,
} from "../src/primitives";

describe("Observatory controls", () => {
  describe("Select", () => {
    const options = [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
      { value: "c", label: "Gamma", disabled: true },
    ];

    it("renders a combobox named by its label", () => {
      render(<Select label="Sort order" value="a" onChange={() => {}} options={options} />);
      expect(screen.getByRole("combobox", { name: "Sort order" })).toBeInTheDocument();
    });

    it("keeps the label in the DOM when hidden visually", () => {
      render(<Select label="Sort order" hideLabel value="a" onChange={() => {}} options={options} />);
      expect(screen.getByRole("combobox", { name: "Sort order" })).toBeInTheDocument();
      expect(screen.getByText("Sort order")).toHaveClass("obs-visually-hidden");
    });

    it("lists every option and marks disabled ones", () => {
      render(<Select label="Sort order" value="a" onChange={() => {}} options={options} />);
      expect(screen.getAllByRole("option")).toHaveLength(3);
      expect(screen.getByRole("option", { name: "Gamma" })).toBeDisabled();
    });

    it("calls onChange with the chosen value", async () => {
      const onChange = vi.fn();
      render(<Select label="Sort order" value="a" onChange={onChange} options={options} />);
      await userEvent.selectOptions(screen.getByRole("combobox"), "b");
      expect(onChange).toHaveBeenCalledWith("b");
    });

    it("forwards disabled, size, className and ref", () => {
      const ref = React.createRef<HTMLSelectElement>();
      const { container } = render(
        <Select ref={ref} label="Sort order" size="sm" className="extra" disabled value="a" onChange={() => {}} options={options} />
      );
      expect(screen.getByRole("combobox")).toBeDisabled();
      expect(ref.current).toBe(screen.getByRole("combobox"));
      expect(container.firstElementChild).toHaveClass("obs-select", "obs-select--sm", "extra");
    });

    it("hides the chevron from assistive tech", () => {
      const { container } = render(<Select label="x" value="a" onChange={() => {}} options={options} />);
      expect(container.querySelector(".obs-select__chevron")).toHaveAttribute("aria-hidden", "true");
    });
  });

  describe("Checkbox", () => {
    it("is a checkbox with an accessible name", () => {
      render(<Checkbox label="Remember me" checked={false} onChange={() => {}} />);
      expect(screen.getByRole("checkbox", { name: "Remember me" })).not.toBeChecked();
    });

    it("reflects the checked prop", () => {
      render(<Checkbox label="Remember me" checked onChange={() => {}} />);
      expect(screen.getByRole("checkbox")).toBeChecked();
    });

    it("toggles via click", async () => {
      const onChange = vi.fn();
      render(<Checkbox label="Remember me" checked={false} onChange={onChange} />);
      await userEvent.click(screen.getByRole("checkbox"));
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it("toggles via the label text", async () => {
      const onChange = vi.fn();
      render(<Checkbox label="Remember me" checked onChange={onChange} />);
      await userEvent.click(screen.getByText("Remember me"));
      expect(onChange).toHaveBeenCalledWith(false);
    });

    it("toggles via Space", async () => {
      const onChange = vi.fn();
      render(<Checkbox label="Remember me" checked={false} onChange={onChange} />);
      await userEvent.tab();
      expect(screen.getByRole("checkbox")).toHaveFocus();
      await userEvent.keyboard(" ");
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it("blocks onChange when disabled", async () => {
      const onChange = vi.fn();
      render(<Checkbox label="Remember me" checked={false} disabled onChange={onChange} />);
      await userEvent.click(screen.getByRole("checkbox"));
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByRole("checkbox")).toBeDisabled();
    });

    it("hides the check mark from assistive tech", () => {
      const { container } = render(<Checkbox label="x" checked onChange={() => {}} />);
      expect(container.querySelector(".obs-checkbox__mark")).toHaveAttribute("aria-hidden", "true");
    });

    it("links a description to the checkbox", () => {
      render(<Checkbox label="Notify me" description="Sent once a day" checked={false} onChange={() => {}} />);
      expect(screen.getByRole("checkbox", { name: "Notify me" })).toHaveAccessibleDescription("Sent once a day");
    });
  });

  describe("SegmentedControl", () => {
    const options = [
      { value: "one", label: "One", icon: <svg data-testid="icon-one" /> },
      { value: "two", label: "Two", icon: <svg data-testid="icon-two" /> },
      { value: "three", label: "Three", icon: <svg data-testid="icon-three" /> },
    ] as const;

    const setup = (value: "one" | "two" | "three", extra: Record<string, unknown> = {}) => {
      const onChange = vi.fn();
      const view = render(
        <SegmentedControl label="View mode" options={[...options]} value={value} onChange={onChange} {...extra} />
      );
      return { onChange, ...view };
    };

    it("is a named radiogroup", () => {
      setup("one");
      expect(screen.getByRole("radiogroup", { name: "View mode" })).toBeInTheDocument();
    });

    it("has exactly one checked radio", () => {
      setup("two");
      const radios = screen.getAllByRole("radio");
      expect(radios).toHaveLength(3);
      expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
      expect(screen.getByRole("radio", { name: "Two" })).toHaveAttribute("aria-checked", "true");
    });

    it("uses a roving tabindex", () => {
      setup("two");
      expect(screen.getByRole("radio", { name: "One" })).toHaveAttribute("tabindex", "-1");
      expect(screen.getByRole("radio", { name: "Two" })).toHaveAttribute("tabindex", "0");
      expect(screen.getByRole("radio", { name: "Three" })).toHaveAttribute("tabindex", "-1");
    });

    it("selects on click", async () => {
      const { onChange } = setup("one");
      await userEvent.click(screen.getByRole("radio", { name: "Three" }));
      expect(onChange).toHaveBeenCalledWith("three");
    });

    it("ArrowRight selects and focuses the next segment", async () => {
      const { onChange } = setup("one");
      screen.getByRole("radio", { name: "One" }).focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(onChange).toHaveBeenCalledWith("two");
      expect(screen.getByRole("radio", { name: "Two" })).toHaveFocus();
    });

    it("ArrowDown behaves like ArrowRight", async () => {
      const { onChange } = setup("one");
      screen.getByRole("radio", { name: "One" }).focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(onChange).toHaveBeenCalledWith("two");
    });

    it("ArrowLeft and ArrowUp select the previous segment", async () => {
      const { onChange } = setup("three");
      screen.getByRole("radio", { name: "Three" }).focus();
      await userEvent.keyboard("{ArrowLeft}");
      expect(onChange).toHaveBeenLastCalledWith("two");
      expect(screen.getByRole("radio", { name: "Two" })).toHaveFocus();
      await userEvent.keyboard("{ArrowUp}");
      expect(onChange).toHaveBeenLastCalledWith("one");
    });

    it("wraps from the last segment to the first and back", async () => {
      const first = setup("three");
      screen.getByRole("radio", { name: "Three" }).focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(first.onChange).toHaveBeenCalledWith("one");
      expect(screen.getByRole("radio", { name: "One" })).toHaveFocus();
      first.unmount();

      const second = setup("one");
      screen.getByRole("radio", { name: "One" }).focus();
      await userEvent.keyboard("{ArrowLeft}");
      expect(second.onChange).toHaveBeenCalledWith("three");
      expect(screen.getByRole("radio", { name: "Three" })).toHaveFocus();
    });

    it("Home and End jump to the ends", async () => {
      const { onChange } = setup("two");
      screen.getByRole("radio", { name: "Two" }).focus();
      await userEvent.keyboard("{End}");
      expect(onChange).toHaveBeenLastCalledWith("three");
      expect(screen.getByRole("radio", { name: "Three" })).toHaveFocus();
      await userEvent.keyboard("{Home}");
      expect(onChange).toHaveBeenLastCalledWith("one");
      expect(screen.getByRole("radio", { name: "One" })).toHaveFocus();
    });

    it("gives icon-only segments an accessible name", () => {
      setup("one", { showLabels: false });
      expect(screen.getByRole("radio", { name: "One" })).toHaveAttribute("aria-label", "One");
      expect(screen.getByRole("radio", { name: "Two" })).toBeInTheDocument();
      expect(screen.queryByText("Two")).not.toBeInTheDocument();
      expect(screen.getByTestId("icon-two")).toBeInTheDocument();
    });

    it("applies size and className", () => {
      setup("one", { size: "sm", className: "extra" });
      expect(screen.getByRole("radiogroup")).toHaveClass("obs-segmented", "obs-segmented--sm", "extra");
    });
  });

  describe("FilterChip", () => {
    it("reflects selected via aria-pressed", () => {
      const { rerender } = render(<FilterChip label="Active" selected={false} onToggle={() => {}} />);
      expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute("aria-pressed", "false");
      rerender(<FilterChip label="Active" selected onToggle={() => {}} />);
      expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute("aria-pressed", "true");
    });

    it("toggles via click", async () => {
      const onToggle = vi.fn();
      render(<FilterChip label="Active" selected={false} onToggle={onToggle} />);
      await userEvent.click(screen.getByRole("button"));
      expect(onToggle).toHaveBeenCalledWith(true);
    });

    it("toggles off when selected", async () => {
      const onToggle = vi.fn();
      render(<FilterChip label="Active" selected onToggle={onToggle} />);
      await userEvent.click(screen.getByRole("button"));
      expect(onToggle).toHaveBeenCalledWith(false);
    });

    it("toggles via Enter and Space", async () => {
      const onToggle = vi.fn();
      render(<FilterChip label="Active" selected={false} onToggle={onToggle} />);
      await userEvent.tab();
      expect(screen.getByRole("button")).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      expect(onToggle).toHaveBeenCalledTimes(2);
    });

    it("shows the count text", () => {
      render(<FilterChip label="Active" count={12} selected={false} onToggle={() => {}} />);
      expect(screen.getByText("12")).toHaveClass("obs-chip__count");
      expect(screen.getByRole("button")).toHaveTextContent("Active");
    });

    it("shows a count of zero", () => {
      render(<FilterChip label="Active" count={0} selected={false} onToggle={() => {}} />);
      expect(screen.getByText("0")).toBeInTheDocument();
    });

    it("renders the pip only when selected", () => {
      const { container, rerender } = render(<FilterChip label="Active" selected={false} onToggle={() => {}} />);
      expect(container.querySelector(".obs-chip__pip")).toBeNull();
      rerender(<FilterChip label="Active" selected onToggle={() => {}} />);
      expect(container.querySelector(".obs-chip__pip")).toHaveAttribute("aria-hidden", "true");
    });

    it("does not fire when disabled", async () => {
      const onToggle = vi.fn();
      render(<FilterChip label="Active" disabled selected={false} onToggle={onToggle} />);
      await userEvent.click(screen.getByRole("button"));
      expect(onToggle).not.toHaveBeenCalled();
    });
  });

  describe("Figure", () => {
    it("renders value and label text", () => {
      render(<Figure value={8} label="planets" />);
      expect(screen.getByText("8")).toHaveClass("obs-figure__value");
      expect(screen.getByText("planets")).toHaveClass("obs-figure__label");
    });

    it("reads naturally as one phrase", () => {
      const { container } = render(<Figure value={8} label="planets" />);
      expect(container.firstElementChild?.textContent).toMatch(/^8\s*planets$/);
      expect(container.querySelector("[aria-hidden]")).toBeNull();
    });

    it("applies the tone class", () => {
      const { container } = render(<Figure value={3} label="failing" tone="alert" />);
      expect(container.firstElementChild).toHaveClass("obs-figure", "obs-figure--alert");
    });

    it("defaults to the default tone and md size", () => {
      const { container } = render(<Figure value={3} label="x" />);
      expect(container.firstElementChild).toHaveClass("obs-figure--default", "obs-figure--md");
    });

    it("applies size, className and title", () => {
      const { container } = render(<Figure value={3} label="x" size="lg" className="extra" title="Three" />);
      expect(container.firstElementChild).toHaveClass("obs-figure--lg", "extra");
      expect(container.firstElementChild).toHaveAttribute("title", "Three");
    });

    it("FigureGroup renders a group with an optional name", () => {
      render(
        <FigureGroup aria-label="Fleet summary">
          <Figure value={8} label="planets" />
          <Figure value={2} label="moons" />
        </FigureGroup>
      );
      const group = screen.getByRole("group", { name: "Fleet summary" });
      expect(group).toHaveClass("obs-figures");
      expect(group).toHaveTextContent("8");
      expect(group).toHaveTextContent("moons");
    });
  });

  describe("Mark", () => {
    it("renders its text", () => {
      render(<Mark>Installed</Mark>);
      expect(screen.getByText("Installed")).toHaveClass("obs-mark__text");
    });

    it("applies tone and shape classes", () => {
      const { container } = render(<Mark tone="success" shape="dot">Installed</Mark>);
      expect(container.firstElementChild).toHaveClass("obs-mark", "obs-mark--success", "obs-mark--dot");
    });

    it("defaults to neutral dot", () => {
      const { container } = render(<Mark>Idle</Mark>);
      expect(container.firstElementChild).toHaveClass("obs-mark--neutral", "obs-mark--dot");
    });

    it("supports ring and diamond shapes", () => {
      const { container, rerender } = render(<Mark shape="ring">x</Mark>);
      expect(container.firstElementChild).toHaveClass("obs-mark--ring");
      rerender(<Mark shape="diamond">x</Mark>);
      expect(container.firstElementChild).toHaveClass("obs-mark--diamond");
    });

    it("hides the shape from assistive tech", () => {
      const { container } = render(<Mark tone="alert">Failed</Mark>);
      expect(container.querySelector(".obs-mark__shape")).toHaveAttribute("aria-hidden", "true");
    });

    it("adds the emphasis class only when asked", () => {
      const { container, rerender } = render(<Mark tone="gilt">Pinned</Mark>);
      expect(container.firstElementChild).not.toHaveClass("obs-mark--emphasis");
      rerender(<Mark tone="gilt" emphasis>Pinned</Mark>);
      expect(container.firstElementChild).toHaveClass("obs-mark--emphasis");
    });

    it("passes className and title", () => {
      const { container } = render(<Mark className="extra" title="Status">x</Mark>);
      expect(container.firstElementChild).toHaveClass("extra");
      expect(container.firstElementChild).toHaveAttribute("title", "Status");
    });
  });
});
