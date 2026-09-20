import { Component } from "react";
import type { ReactNode } from "react";

// Keep a renderer failure inside the decorative scene; retry remounts only that subtree.
export class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <div className="scene-recovery" role="alert">
        <p>3D-графика временно недоступна</p>
        <button type="button" className="cinema-btn ghost" onClick={() => this.setState({ failed: false })}>
          Восстановить 3D
        </button>
      </div>;
    }
    return this.props.children;
  }
}
