import { DesignSystem } from "../../types";

const NO_DESIGN_SYSTEM = "__none__";
const ADD_NEW = "__add_new__";
const MANAGE = "__manage__";

export interface DesignSystemSelectorProps {
  designSystems: DesignSystem[];
  selectedDesignSystemId: string | null;
  setSelectedDesignSystemId: (id: string | null) => void;
  onAddNew: () => void;
  onManage: () => void;
  disabled?: boolean;
  compact?: boolean;
}

function DesignSystemSelector({
  designSystems,
  selectedDesignSystemId,
  setSelectedDesignSystemId,
  onAddNew,
  onManage,
  disabled = false,
  compact = false,
}: DesignSystemSelectorProps) {
  const handleValueChange = (value: string) => {
    if (value === ADD_NEW) {
      onAddNew();
      return;
    }
    if (value === MANAGE) {
      onManage();
      return;
    }
    setSelectedDesignSystemId(value === NO_DESIGN_SYSTEM ? null : value);
  };

  const selectedDesignSystem = designSystems.find(
    (item) => item.id === selectedDesignSystemId
  );
  const hasSelection = selectedDesignSystem !== undefined;
  const selectClasses =
    "rounded-md border border-input bg-transparent px-2 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <select
      data-testid="design-system-select"
      aria-label={
        hasSelection
          ? `Design system: ${selectedDesignSystem.name}`
          : "Add a design system"
      }
      title={
        hasSelection
          ? `Design system: ${selectedDesignSystem.name}`
          : "Add a design system"
      }
      value={selectedDesignSystemId ?? NO_DESIGN_SYSTEM}
      disabled={disabled}
      onChange={(event) => handleValueChange(event.target.value)}
      className={
        compact
          ? `${selectClasses} h-7 max-w-[180px] rounded-full text-xs`
          : `${selectClasses} col-span-2`
      }
    >
      <option value={NO_DESIGN_SYSTEM}>No design system</option>
      {designSystems.map((designSystem) => (
        <option key={designSystem.id} value={designSystem.id}>
          {designSystem.name}
        </option>
      ))}
      <optgroup label="More">
        <option value={ADD_NEW} data-testid="design-system-add-new">
          + New design system…
        </option>
        {designSystems.length > 0 && (
          <option value={MANAGE} data-testid="design-system-manage">
            Manage design systems…
          </option>
        )}
      </optgroup>
    </select>
  );
}

export default DesignSystemSelector;
