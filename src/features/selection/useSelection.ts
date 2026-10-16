import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Selection mode and a set of stable IDs (Library catalog IDs, dictionary IDs), independent of any
 * bulk action. IDs that are no longer available drop out of the selection.
 */
export function useSelection<Id extends string | number>(availableIds: Id[]) {
  const [active, setActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<Id>>(() => new Set());
  const availableIdSet = useMemo(() => new Set(availableIds), [availableIds]);

  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => availableIdSet.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [availableIdSet]);

  const enter = useCallback(() => setActive(true), []);
  const cancel = useCallback(() => {
    setActive(false);
    setSelectedIds(new Set());
  }, []);
  const toggle = useCallback((id: Id) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectAll = useCallback(() => setSelectedIds(new Set(availableIds)), [availableIds]);
  const replace = useCallback((ids: Iterable<Id>) => setSelectedIds(new Set(ids)), []);
  const add = useCallback(
    (ids: Iterable<Id>) => setSelectedIds((current) => new Set([...current, ...ids])),
    [],
  );

  return {
    active,
    add,
    cancel,
    enter,
    isSelected: useCallback((id: Id) => selectedIds.has(id), [selectedIds]),
    replace,
    selectAll,
    selectedCount: selectedIds.size,
    selectedIds,
    toggle,
  };
}
