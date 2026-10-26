# Execução no servidor Oracle

A instalação usa uma VM Ubuntu 24.04 x86_64 Always Free (E2.1.Micro), 1 GB de RAM,
disco de 47 GB e 1 GB de swap. A A1 ARM não tinha capacidade no momento da criação.

## Serviços

`compose.server.yaml` mantém o bot e Cobalt na mesma rede interna, sem publicar portas.
Sessão em `./data/auth`, lista em `./allowed-numbers.json`; ambos fora do Git.
O Docker inicia no boot; os serviços usam `restart: unless-stopped`.
Logs têm rotação (3 arquivos de até 10 MB por serviço).

No servidor, em `/home/ubuntu/r-daneel-whatsapp`:

```sh
sudo docker build -t r-daneel-bot:local .
sudo docker compose -f compose.server.yaml up -d
sudo docker compose -f compose.server.yaml ps
sudo docker compose -f compose.server.yaml logs --tail 30 bot
sudo docker stats --no-stream
```

O usuário `node` da imagem tem UID/GID 1000. Após transferir sessão e lista, ajuste:

```sh
sudo chown -R 1000:1000 data
sudo chmod 700 data
sudo chown 1000:1000 allowed-numbers.json
sudo chmod 600 allowed-numbers.json
```

Para reiniciar após editar a lista de números:

```sh
sudo docker compose -f compose.server.yaml restart bot
```

Para parar sem apagar sessão:

```sh
sudo docker compose -f compose.server.yaml stop
```

Não execute a mesma sessão simultaneamente no Mac e no servidor.
Não use `down -v` como procedimento de manutenção. Preserve backup privado da sessão.
A chave de acesso local fica em `data/ssh/oracle-r-daneel.key` (permissão 600), fora do Git.
O endereço da VM fica no painel Oracle; nenhum endereço ou credencial precisa entrar no código.

## Atualização

Revise a alteração, envie o código aprovado ao GitHub, pare o serviço e faça pull/build.
A imagem do Cobalt deve ser atualizada deliberadamente após testes. O manifesto usa
um digest quando disponível para evitar mudança silenciosa de versão.

## Limitações

A quantidade de RAM é pequena: medir picos antes de aumentar carga. Swap não substitui RAM.
Acesso ao Instagram depende do IP e pode diferir do Mac. A Oracle pode recuperar VMs
Always Free consideradas ociosas segundo a política vigente. O armazenamento Baileys
continua baseado em arquivos, adequado a esta instalação pessoal experimental.

## Validação em 26/10/2026

Imagem Linux construída na VM. Sessão existente conectou sem novo QR.
Conversão em WebP 512x512 passou no container de produção.
O Reel `DejIhofCWYv` baixou com yt-dlp e com contingência Cobalt forçada,
com validação de duração por ffprobe (5.300.534 bytes em cada caminho).
O envio final deve ser conferido por uma mensagem de teste do usuário no WhatsApp.
