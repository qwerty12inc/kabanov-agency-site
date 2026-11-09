// Скрытые кейсы: один список для всех шагов (fixes.mjs, hide-queries.mjs,
// check-hidden.mjs). Чтобы вернуть кейс, уберите его слаг отсюда и запустите
// `npm run fixes` — код Framer при этом трогать не нужно (см. ниже).
export const HIDDEN_CASES = ['3d-movie-muted'];

// Поле слага в коллекции проектов Framer (Jo_ECrywm). Имя служебное, видно в
// запросах чанков: select:[{name:`cUGfm0XTC`}] и маршрут /projects/:cUGfm0XTC.
export const SLUG_FIELD = 'cUGfm0XTC';

/**
 * Функция, которую вызывают пропатченные запросы списков (hide-queries.mjs).
 * Строит условие «слаг не равен ни одному скрытому» на языке запросов Framer и
 * добавляет его к существующему условию, если оно есть.
 *
 * Живёт в HTML, а не в чанке, нарочно. Чанки /assets/js отдаются с immutable на
 * год, HTML — с must-revalidate. Значит, список скрытых меняется без правки
 * кода и без переименования файлов: достаточно `npm run fixes`. В чанке стоит
 * только вызов, и если функции нет, запрос остаётся прежним.
 */
export const hideScript = () =>
  `window.__kdaHide=function(a,w){var c=null;${JSON.stringify(HIDDEN_CASES)}.forEach(function(s){` +
  `var n={type:"BinaryOperation",operator:"!=",left:{collection:a,name:"${SLUG_FIELD}",type:"Identifier"},right:{type:"LiteralValue",value:s}};` +
  `c=c?{type:"BinaryOperation",operator:"and",left:c,right:n}:n});` +
  `return c?(w?{type:"BinaryOperation",operator:"and",left:w,right:c}:c):w};`;
