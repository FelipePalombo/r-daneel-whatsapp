#!/bin/zsh
cd -- "${0:A:h}" || exit 1
export PATH="/Users/felipepalombo/.nvm/versions/node/v22.12.0/bin:$PATH"
printf '\nR. Daneel — vincule pelo WhatsApp Business do bot: Configurações → Aparelhos conectados.\nNão compartilhe o QR ou esta janela. Para encerrar, pressione Ctrl+C.\n\n'
PAIRING_MODE=true npm start
printf '\nR. Daneel foi encerrado. Pressione Enter para fechar.\n'
read
