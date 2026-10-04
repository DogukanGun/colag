"use client";
import { useEffect, useRef } from "react";

export default function SandboxTerminal({ streamUrl }: { streamUrl: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let cancel = false;
    let socket: WebSocket | undefined;
    let terminal: { dispose: () => void } | undefined;
    let observer: ResizeObserver | undefined;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      await import("@xterm/xterm/css/xterm.css");
      if (cancel) return;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        theme: { background: "#101c22", foreground: "#f4f1e8", cursor: "#8fd0c8" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(node);
      fit.fit();
      terminal = term;
      socket = new WebSocket(streamUrl);
      socket.binaryType = "arraybuffer";
      const sendSize = () => {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };
      socket.onopen = sendSize;
      socket.onmessage = (event) => {
        if (typeof event.data === "string") term.write(event.data);
        else term.write(new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onclose = () => {
        if (!cancel) term.write("\r\n\r\n[sandbox closed]\r\n");
      };
      term.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(new TextEncoder().encode(data));
      });
      observer = new ResizeObserver(() => {
        fit.fit();
        sendSize();
      });
      observer.observe(node);
      if (cancel) {
        observer.disconnect();
        socket.close();
        term.dispose();
      }
    })();
    return () => {
      cancel = true;
      observer?.disconnect();
      socket?.close();
      terminal?.dispose();
    };
  }, [streamUrl]);
  return <div ref={ref} className="sandbox-terminal" />;
}
