import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_LABELS,eventLabel,settingHint,settingValueValid,reasonValid }
  from '../src/components/portalSettingsModel';

test('политики имеют подписи без технических кодов', () => {
  assert.equal(POLICY_LABELS.ASSIGNEE, 'Ответственному по задаче');
  assert.equal(POLICY_LABELS.NONE, 'Не рассылать');
  assert.equal(Object.keys(POLICY_LABELS).length, 3);
});

test('неизвестное событие показывается своим кодом, а не пустой строкой', () => {
  assert.equal(eventLabel('work_item.assigned'),
    'Назначена задача (в том числе по отклонению показателя)');
  assert.equal(eventLabel('some.future.event'), 'some.future.event');
});

test('подсказка диапазона учитывает единицу и целочисленность', () => {
  assert.equal(settingHint({min:1,max:720,integer:true,unit:'HOURS'}),
    'Допустимо целое значение от 1 до 720 часов.');
  assert.equal(settingHint({min:null,max:null,integer:false,unit:'NUMBER'}), '');
});

test('значение настройки проверяется теми же границами, что на сервере', () => {
  const spec={min:1,max:720,integer:true};
  assert.equal(settingValueValid('72', spec), true);
  assert.equal(settingValueValid('0', spec), false);
  assert.equal(settingValueValid('721', spec), false);
  assert.equal(settingValueValid('12.5', spec), false);
  assert.equal(settingValueValid('', spec), false);
  assert.equal(settingValueValid('abc', spec), false);
});

test('основание обязательно и ограничено по длине', () => {
  assert.equal(reasonValid('коротко'), false);
  assert.equal(reasonValid('Сужаем окно близкого срока по решению дивизиона'), true);
  assert.equal(reasonValid('а'.repeat(501)), false);
});
