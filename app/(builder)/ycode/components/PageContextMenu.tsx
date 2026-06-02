'use client';

import React, { useState } from 'react';
import { ContextMenu,ContextMenuContent,ContextMenuItem,ContextMenuSeparator,ContextMenuTrigger } from '@/components/ui/context-menu';
import type { Page, PageFolder } from '@/types';
import type { StatusAction } from '@/lib/collection-field-utils';
import { isHomepage } from '@/lib/page-utils';
import type { PageStatusAvailability } from './PageStatusBadge';

interface PageContextMenuProps {
  item: Page | PageFolder;
  children: React.ReactNode;
  nodeType: 'page' | 'folder';
  onOpen?: () => void; // For pages
  onRename?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onSettings?: () => void;
  onAddPage?: () => void; // For folders
  onAddFolder?: () => void; // For folders
  onStatusChange?: (action: StatusAction) => void; // For pages
  statusAvailability?: PageStatusAvailability;
}

/**
 * Heavy inner half: menu items, derived guards, and the Radix portal content.
 * Mounted only when the menu is open so each row of the pages tree carries
 * just a thin trigger shell at rest.
 */
function PageContextMenuInner({
  item,
  nodeType,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onSettings,
  onAddPage,
  onAddFolder,
  onStatusChange,
  statusAvailability,
}: Omit<PageContextMenuProps, 'children'>) {
  const isItemHomepage = nodeType === 'page' && isHomepage(item as Page);
  const isItemDynamic = nodeType === 'page' && (item as Page).is_dynamic;
  const isTempItem = item.id.startsWith('temp-page-') || item.id.startsWith('temp-folder-');

  return (
    <ContextMenuContent className="w-44">

      {onSettings && (
        <ContextMenuItem onClick={onSettings}>
          <span>{nodeType === 'page' ? 'Page settings' : 'Folder settings'}</span>
        </ContextMenuItem>
      )}

      {nodeType === 'page' && onOpen && (
        <>
          <ContextMenuItem onClick={onOpen}>
            <span>Open page</span>
          </ContextMenuItem>
        </>
      )}

      {onStatusChange && statusAvailability && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => onStatusChange('stage')}
            disabled={!statusAvailability.canStage}
          >
            <span>Stage for publish</span>
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onStatusChange('draft')}
            disabled={!statusAvailability.canDraft}
          >
            <span>Set as draft</span>
          </ContextMenuItem>
        </>
      )}

      {((nodeType === 'folder' && (onAddPage || onAddFolder)) || onRename) && <ContextMenuSeparator />}

      {nodeType === 'folder' && (
        <>
          {onAddPage && (
            <ContextMenuItem onClick={onAddPage}>
              <span>Add Page</span>
            </ContextMenuItem>
          )}
          {onAddFolder && (
            <ContextMenuItem onClick={onAddFolder}>
              <span>Add Folder</span>
            </ContextMenuItem>
          )}
        </>
      )}

      {onRename && (
        <ContextMenuItem onClick={onRename}>
          <span>Rename</span>
        </ContextMenuItem>
      )}

      {(onDuplicate || onDelete) && <ContextMenuSeparator />}

      {onDuplicate && (
        <ContextMenuItem onClick={onDuplicate} disabled={isItemDynamic}>
          <span>Duplicate</span>
        </ContextMenuItem>
      )}

      {onDelete && (
        <ContextMenuItem onClick={onDelete} disabled={isItemHomepage || isTempItem}>
          <span>Delete</span>
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}

function PageContextMenu({
  item,
  children,
  nodeType,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onSettings,
  onAddPage,
  onAddFolder,
  onStatusChange,
  statusAvailability,
}: PageContextMenuProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <ContextMenu onOpenChange={setIsOpen}>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      {isOpen && (
        <PageContextMenuInner
          item={item}
          nodeType={nodeType}
          onOpen={onOpen}
          onRename={onRename}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onSettings={onSettings}
          onAddPage={onAddPage}
          onAddFolder={onAddFolder}
          onStatusChange={onStatusChange}
          statusAvailability={statusAvailability}
        />
      )}
    </ContextMenu>
  );
}

export default React.memo(PageContextMenu);
