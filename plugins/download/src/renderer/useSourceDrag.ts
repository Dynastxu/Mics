import { ref, type Ref } from 'vue'

export function useSourceDrag() {
  const dragIndex = ref(-1)
  const overIndex = ref(-1)

  function resetDrag(): void {
    dragIndex.value = -1
    overIndex.value = -1
  }

  function onDragStart(index: number, event: DragEvent): void {
    dragIndex.value = index
    overIndex.value = index
    event.dataTransfer?.setData('text/plain', String(index))
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function onDragOver(index: number, event: DragEvent): void {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    overIndex.value = index
  }

  function onDrop<T>(
    items: Ref<T[]>,
    index: number,
    onChanged: () => void,
  ): void {
    const from = dragIndex.value
    resetDrag()
    if (from < 0 || from === index) return
    const list = [...items.value]
    const [item] = list.splice(from, 1)
    if (!item) return
    list.splice(index, 0, item)
    items.value = list
    onChanged()
  }

  return { dragIndex, overIndex, resetDrag, onDragStart, onDragOver, onDrop }
}