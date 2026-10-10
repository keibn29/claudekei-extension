/** DOM id of the open autocomplete popup (target of the editor's aria-controls). */
export const COMPOSER_POPUP_ID = 'composer-autocomplete-popup';

export const composerPopupOptionId = (index: number): string => `${COMPOSER_POPUP_ID}-option-${index}`;
