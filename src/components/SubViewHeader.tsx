import type { ReactNode } from "react";

type SubViewHeaderProps = {
  title: string;
  onBack: () => void;
  actions?: ReactNode;
};

function SubViewHeader({ title, onBack, actions }: SubViewHeaderProps) {
  return (
    <div className="sub-view-header">
      <div className="back-btn" onClick={onBack}>
        <span className="back-icon">←</span> 返回
      </div>
      <h2 className="sub-view-title">{title}</h2>
      {actions}
    </div>
  );
}

export default SubViewHeader;
