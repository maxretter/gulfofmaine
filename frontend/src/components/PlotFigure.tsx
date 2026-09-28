import * as Plot from "@observablehq/plot";
import { useEffect, useRef } from "react";

export type PlotElement = ReturnType<typeof Plot.plot>;

interface Props {
  /** Memoize these: the plot is rebuilt whenever the object changes. */
  options: Plot.PlotOptions;
  /** Called after each render, e.g. to attach listeners; may return a cleanup. */
  onRender?: (plot: PlotElement) => void | (() => void);
  className?: string;
}

/** Renders an Observable Plot chart, rebuilding it when its options change. */
export function PlotFigure({ options, onRender, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const plot = Plot.plot(options);
    ref.current?.replaceChildren(plot);
    const cleanup = onRender?.(plot);
    return () => {
      cleanup?.();
      plot.remove();
    };
  }, [options, onRender]);
  return <div ref={ref} className={className} />;
}
