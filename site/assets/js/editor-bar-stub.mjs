// Заглушка панели редактирования Framer: в автономной копии редактор не нужен.
// Должна возвращать именно React-компонент — результат рендерится как ленивый.
export const createEditorBar = () => () => null;
export default { createEditorBar };
