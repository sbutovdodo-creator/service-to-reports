export type PhotoSlot = {
  key: string;
  label: string;
  required: boolean;
};

export type PhotoRequirement = {
  id: string;
  title: string;
  note?: string;
  slots: PhotoSlot[];
};

export const photoRequirements: PhotoRequirement[] = [
  { id: "oven", title: "Печь и шильдик", note: "Шильдик — по возможности", slots: [{ key: "oven-overview", label: "Печь", required: true }, { key: "oven-nameplate", label: "Шильдик", required: false }] },
  { id: "heaters", title: "Отсек с ТЭНами", slots: [{ key: "heaters-before", label: "До", required: true }, { key: "heaters-after", label: "После", required: true }] },
  { id: "chain", title: "Цепь конвейера", slots: [{ key: "chain", label: "Фото", required: true }] },
  { id: "conveyor", title: "Конвейер сбоку в приподнятом состоянии", note: "Только при необходимости натяжки", slots: [{ key: "conveyor-tension", label: "Фото", required: false }] },
  { id: "plugs", title: "Вилки и розетки", slots: [{ key: "plugs-before", label: "Разобрано", required: true }, { key: "plugs-after", label: "Собрано", required: true }] },
  { id: "conduit-oven", title: "Муфты металлорукава ввода в печь", slots: [{ key: "conduit-oven", label: "Фото", required: true }] },
  { id: "conduit-socket", title: "Примыкание металлорукава у розетки", slots: [{ key: "conduit-socket", label: "Фото", required: true }] },
  { id: "ground", title: "Заземление печи", slots: [{ key: "ground", label: "Фото", required: true }] },
  { id: "controls", title: "Блоки управления и электроснабжения", slots: [{ key: "controls-before", label: "До", required: true }, { key: "controls-after", label: "После", required: true }] },
  { id: "contacts", title: "Контакты со снятыми изоляторами", slots: [{ key: "contacts", label: "Фото", required: true }] },
  { id: "seal", title: "Уплотнитель дверцы", note: "По наличию", slots: [{ key: "door-seal", label: "Фото", required: false }] },
  { id: "filters", title: "Заменённые или вымытые фильтры", slots: [{ key: "filters", label: "После", required: true }] },
  { id: "heater-measures", title: "Замеры нагрузки и сопротивления ТЭНов", slots: [{ key: "heater-load", label: "Нагрузка", required: true }, { key: "heater-resistance", label: "Сопротивление", required: true }] },
  { id: "voltage-measures", title: "Замеры напряжения", slots: [{ key: "phase-voltage", label: "На фазах", required: true }, { key: "psu-voltage", label: "Выход БП", required: true }] },
  { id: "extra-work", title: "Дополнительные работы", note: "Если выполнялись", slots: [{ key: "extra-before", label: "До", required: false }, { key: "extra-after", label: "После", required: false }] },
];

export const allPhotoSlots = photoRequirements.flatMap((requirement) => requirement.slots.map((slot) => ({ ...slot, requirementTitle: requirement.title })));
export const requiredPhotoSlots = allPhotoSlots.filter((slot) => slot.required);

