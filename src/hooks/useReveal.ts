import { useEffect, useRef } from "react";

/**
 * Fluent Reveal Highlight — tracks mouse position on a container
 * and sets CSS custom properties for radial-gradient effects.
 *
 * Usage:
 *   const ref = useReveal<HTMLDivElement>();
 *   <div ref={ref} className="reveal-container"> ... </div>
 *
 * Children with class `.reveal-target` get the highlight automatically.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const onMove = (e: MouseEvent) => {
      const targets = container.querySelectorAll<HTMLElement>(".reveal-target");
      targets.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        el.style.setProperty("--reveal-x", `${x}px`);
        el.style.setProperty("--reveal-y", `${y}px`);
      });
    };

    const onLeave = () => {
      const targets = container.querySelectorAll<HTMLElement>(".reveal-target");
      targets.forEach((el) => {
        el.style.setProperty("--reveal-x", `-999px`);
        el.style.setProperty("--reveal-y", `-999px`);
      });
    };

    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", onLeave);
    return () => {
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return ref;
}
