import React, { useState, useId, useEffect } from "react";

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
  className?: string;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  className = "",
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const id = useId();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsVisible(false);
      }
    };

    if (isVisible) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [isVisible]);

  const show = () => setIsVisible(true);
  const hide = () => setIsVisible(false);

  const childProps = children.props as React.HTMLAttributes<HTMLElement>;

  const child = React.cloneElement(children, {
    "aria-describedby": isVisible ? id : undefined,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(e);
      show();
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(e);
      hide();
    },
  });

  return (
    <div className="obs-tooltip-wrapper">
      {child}
      {isVisible && (
        <div
          role="tooltip"
          id={id}
          className={`obs-tooltip ${className}`.trim()}
        >
          {content}
        </div>
      )}
    </div>
  );
};
