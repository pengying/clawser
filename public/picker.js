export class NativePickerUI {
  #descriptor = null;
  #busy = false;
  #colorValid = true;
  #generation = 0;
  #syncViewport = () => {
    const viewport = window.visualViewport;
    this.dialog.style.setProperty('--picker-visible-top', `${viewport?.offsetTop || 0}px`);
    this.dialog.style.setProperty('--picker-visible-height', `${viewport?.height || innerHeight}px`);
    this.dialog.classList.toggle('picker-keyboard-compact', Boolean(
      this.#descriptor?.kind === 'color' && viewport && viewport.width > viewport.height && viewport.height < 240,
    ));
  };

  constructor({ onApply, onCancel }) {
    this.onApply = typeof onApply === 'function' ? onApply : () => {};
    this.onCancel = typeof onCancel === 'function' ? onCancel : () => {};
    this.dialog = document.querySelector('#nativePicker');
    if (!this.dialog) throw new Error('Native picker dialog is missing');
    this.title = this.dialog.querySelector('.picker-title');
    this.content = this.dialog.querySelector('.picker-content');
    this.applyButton = this.dialog.querySelector('.picker-apply');
    this.cancelButton = this.dialog.querySelector('.picker-cancel');
    window.visualViewport?.addEventListener('resize', this.#syncViewport);
    window.visualViewport?.addEventListener('scroll', this.#syncViewport);
    window.addEventListener('resize', this.#syncViewport);
    this.#syncViewport();
    this.cancelButton.addEventListener('click', () => this.#cancel());
    this.applyButton.addEventListener('click', () => this.#commit());
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.#cancel();
    });
  }

  get active() { return this.#descriptor; }

  show(descriptor) {
    if (!descriptor || !['select', 'color'].includes(descriptor.kind)) throw new TypeError('Invalid picker descriptor');
    this.close();
    this.#descriptor = descriptor;
    this.#busy = false;
    this.#colorValid = true;
    const generation = this.#generation;
    if (descriptor.kind === 'select') this.#renderSelect(descriptor, generation);
    else this.#renderColor(descriptor, generation);
    this.#syncViewport();
    this.dialog.showModal();
    const initial = this.content.querySelector('[data-picker-control]:checked') ||
      this.content.querySelector('[data-picker-control]:not(:disabled)');
    initial?.focus({ preventScroll: true });
  }

  close() {
    this.#generation++;
    if (this.dialog.open) this.dialog.close();
    this.#descriptor = null;
    this.#busy = false;
    this.content.replaceChildren();
    this.dialog.classList.remove('picker-keyboard-compact');
    this.dialog.removeAttribute('aria-busy');
  }

  setBusy(busy) {
    if (!this.#descriptor) return;
    this.#busy = Boolean(busy);
    this.dialog.toggleAttribute('aria-busy', this.#busy);
    this.#syncDisabled();
  }

  #renderSelect(descriptor, generation) {
    this.title.textContent = descriptor.multiple ? 'Choose options' : 'Choose an option';
    this.applyButton.hidden = !descriptor.multiple;
    let previousGroup;
    for (const option of descriptor.options || []) {
      if (option.group && option.group !== previousGroup) {
        const group = document.createElement('p');
        group.className = 'picker-group';
        group.textContent = option.group;
        this.content.append(group);
      }
      previousGroup = option.group;
      if (descriptor.multiple) this.#appendCheckbox(option);
      else this.#appendChoice(option, descriptor, generation);
    }
    this.#syncDisabled();
  }

  #appendChoice(option, descriptor, generation) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker-option';
    button.dataset.pickerControl = '';
    button.dataset.optionDisabled = String(Boolean(option.disabled));
    button.textContent = String(option.label ?? '');
    if (option.selected) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => {
      if (!this.#isCurrent(descriptor, generation)) return;
      this.#commit({ indices: [option.index] });
    });
    this.content.append(button);
  }

  #appendCheckbox(option) {
    const label = document.createElement('label');
    label.className = 'picker-option picker-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(option.selected);
    checkbox.value = String(option.index);
    checkbox.dataset.index = String(option.index);
    checkbox.dataset.pickerControl = '';
    checkbox.dataset.optionDisabled = String(Boolean(option.disabled));
    const text = document.createElement('span');
    text.textContent = String(option.label ?? '');
    label.append(checkbox, text);
    this.content.append(label);
  }

  #renderColor(descriptor, generation) {
    this.title.textContent = 'Choose a color';
    this.applyButton.hidden = false;
    const value = /^#[0-9a-f]{6}$/i.test(descriptor.value || '') ? descriptor.value.toLowerCase() : '#000000';
    const row = document.createElement('div');
    row.className = 'picker-color-row';

    const colorLabel = document.createElement('label');
    colorLabel.className = 'picker-swatch-label';
    const colorText = document.createElement('span');
    colorText.textContent = 'Color';
    const color = document.createElement('input');
    color.type = 'color';
    color.className = 'picker-color';
    color.value = value;
    color.dataset.pickerControl = '';
    colorLabel.append(colorText, color);

    const hexLabel = document.createElement('label');
    hexLabel.className = 'picker-hex-label';
    const hexText = document.createElement('span');
    hexText.textContent = 'Hex';
    const hexField = document.createElement('span');
    hexField.className = 'picker-hex-field';
    hexField.textContent = '#';
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.className = 'picker-hex';
    hex.value = value.slice(1);
    hex.maxLength = 6;
    hex.pattern = '[0-9A-Fa-f]{6}';
    hex.autocomplete = 'off';
    hex.autocapitalize = 'none';
    hex.spellcheck = false;
    hex.dataset.pickerControl = '';
    hex.setAttribute('aria-label', 'Six-digit hex color');
    hexField.append(hex);
    hexLabel.append(hexText, hexField);
    row.append(colorLabel, hexLabel);
    this.content.append(row);

    color.addEventListener('input', () => {
      if (!this.#isCurrent(descriptor, generation)) return;
      hex.value = color.value.slice(1);
      this.#colorValid = true;
      this.#syncDisabled();
    });
    hex.addEventListener('input', () => {
      if (!this.#isCurrent(descriptor, generation)) return;
      this.#colorValid = /^[0-9a-f]{6}$/i.test(hex.value);
      if (this.#colorValid) color.value = `#${hex.value.toLowerCase()}`;
      this.#syncDisabled();
    });
    this.#syncDisabled();
  }

  #syncDisabled() {
    for (const control of this.dialog.querySelectorAll('[data-picker-control]')) {
      control.disabled = this.#busy || control.dataset.optionDisabled === 'true';
    }
    this.cancelButton.disabled = this.#busy;
    this.applyButton.disabled = this.#busy || (this.#descriptor?.kind === 'color' && !this.#colorValid);
  }

  #isCurrent(descriptor, generation) {
    return this.#descriptor === descriptor && this.#generation === generation;
  }

  #commit(detail) {
    if (!this.#descriptor || this.#busy) return;
    if (!detail && this.#descriptor.kind === 'select') {
      detail = { indices: [...this.content.querySelectorAll('input[type="checkbox"]:checked')].map((input) => Number(input.dataset.index)) };
    } else if (!detail && this.#descriptor.kind === 'color') {
      const hex = this.content.querySelector('.picker-hex').value;
      if (!/^[0-9a-f]{6}$/i.test(hex)) return;
      detail = { color: `#${hex.toLowerCase()}` };
    }
    this.setBusy(true);
    try { this.onApply(detail); }
    catch (error) { this.setBusy(false); throw error; }
  }

  #cancel() {
    if (!this.#descriptor || this.#busy) return;
    this.onCancel();
    this.close();
  }
}
