export type ChecklistItem = {
  id: string;
  number: string;
  title: string;
  group: "inspection" | "maintenance";
};

export const ovenChecklist: ChecklistItem[] = [
  { id: "inspection-deformation", number: "1.1", title: "Отсутствуют деформации элементов печи", group: "inspection" },
  { id: "inspection-noise", number: "1.2", title: "Отсутствуют посторонние шумы двигателя, кулера, двигателя конвейера и конвейерной ленты", group: "inspection" },
  { id: "inspection-links", number: "1.3", title: "Отсутствует деформация звеньев конвейерной ленты", group: "inspection" },
  { id: "inspection-belt", number: "1.4", title: "Отсутствует провисание конвейерной ленты", group: "inspection" },
  { id: "inspection-seal", number: "1.5", title: "Проверена целостность уплотнителя дверцы печи", group: "inspection" },
  { id: "inspection-plugs", number: "1.6", title: "На силовых вилках и розетках отсутствуют сколы, трещины и поломки", group: "inspection" },
  { id: "inspection-burnt-plugs", number: "1.7", title: "В силовых вилках и розетках отсутствуют прогоревшие контакты", group: "inspection" },
  { id: "inspection-cable", number: "1.8", title: "Отсутствуют повреждения изоляции силового кабеля", group: "inspection" },
  { id: "inspection-conduit", number: "1.9", title: "Силовой кабель защищён металлорукавом, повреждения отсутствуют", group: "inspection" },
  { id: "inspection-section", number: "1.10", title: "Сечение вводного кабеля соответствует номиналу — не менее 10 мм²", group: "inspection" },
  { id: "inspection-fireproof", number: "1.11", title: "Изоляция вводного кабеля выполнена из негорючего материала", group: "inspection" },
  { id: "inspection-automation", number: "1.12", title: "Отсутствуют прогоревшие контакты, наконечники и провода системы автоматики", group: "inspection" },
  { id: "inspection-display", number: "1.13", title: "Сенсор дисплея работает исправно", group: "inspection" },
  { id: "clean-control", number: "2", title: "Очищены защитные устройства и коммутационная аппаратура в блоке управления и в районе ТЭНов", group: "maintenance" },
  { id: "clean-convection", number: "3", title: "Очищен двигатель конвекции от пыли и посторонних предметов", group: "maintenance" },
  { id: "tighten-contacts", number: "4", title: "Выполнена протяжка всех контактных электрических соединений в печи", group: "maintenance" },
  { id: "replace-filters", number: "5", title: "Выполнена замена фильтров", group: "maintenance" },
  { id: "measure-resistance", number: "6", title: "Выполнены замеры сопротивления ТЭНов", group: "maintenance" },
  { id: "measure-load", number: "7", title: "Выполнены замеры нагрузки на ТЭНы", group: "maintenance" },
  { id: "measure-ac", number: "8", title: "Измерено напряжение переменного тока на каждой фазе", group: "maintenance" },
  { id: "measure-dc", number: "9", title: "Измерено напряжение постоянного тока на выходе блока питания", group: "maintenance" },
  { id: "check-ground", number: "10", title: "Проверено заземление печи", group: "maintenance" },
];
