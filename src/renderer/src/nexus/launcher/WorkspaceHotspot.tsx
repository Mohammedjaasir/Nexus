import { forwardRef } from 'react';
import { IconTile } from '../ui/IconTile';
import { Icon, type NexusIconName } from '../icons';
import type { Hue } from '../iconNames';

export interface HotspotModel { key: string; label: string; tagline: string; description: string; icon: NexusIconName; hue: Hue | 'accent'; x: number; y: number; count: number | null; onOpen: () => void }

export const WorkspaceHotspot = forwardRef<HTMLButtonElement, { model: HotspotModel; index: number; focusIndex: number; mode: 'stage' | 'grid'; onFocusIndex: (i: number) => void; onKeyDown: (e: React.KeyboardEvent) => void }>(
  function WorkspaceHotspot({ model, index, focusIndex, mode, onFocusIndex, onKeyDown }, ref) {
    const style = mode === 'stage' ? { left: `${model.x}%`, top: `${model.y}%`, animationDelay: `${(index % 5) * -1.2}s` } : undefined;
    return (
      <div className={`nx-hs-wrap nx-hs-wrap--${mode}`} style={style} data-hue={model.hue}>
        {mode === 'stage' && <span className="nx-hs-island" aria-hidden="true" />}
        <button
          ref={ref}
          type="button"
          className="nx-hs"
          tabIndex={mode === 'stage' ? (index === focusIndex ? 0 : -1) : 0}
          onFocus={() => onFocusIndex(index)}
          onKeyDown={onKeyDown}
          onClick={model.onOpen}
          aria-describedby={`nx-hs-desc-${model.key}`}
        >
          {model.hue === 'accent' ? <span className="nx-tile nx-tile--md nx-tile--accent"><Icon name={model.icon} size={18} /></span> : <IconTile icon={model.icon} hue={model.hue} size="md" />}
          <span className="nx-hs__text">
            <span className="nx-hs__label">{model.label}<Icon name="chevronRight" size={14} /></span>
            {model.tagline && <span className="nx-hs__tag">{model.tagline}</span>}
          </span>
          {model.count !== null && model.count > 0 && <span className="nx-hs__count">{model.count}</span>}
        </button>
        <span id={`nx-hs-desc-${model.key}`} className="nx-hs__tip" role="tooltip">
          {model.description}{model.count ? ` · ${model.count} project${model.count === 1 ? '' : 's'}` : ''}
        </span>
      </div>
    );
  }
);
