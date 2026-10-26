# Escolhas para o MVP — pesquisa em 24/10/2026

## Linguagem e integração

| Opção | Adequação |
|---|---|
| C# + API oficial Meta | Boa opção para webhooks, HttpClient e serviço de conversão; exige onboarding Business e não usa apenas vinculação de dispositivo por QR. |
| C# + ponte Node/HTTP | Preserva C# na lógica, mas adiciona um segundo processo e contrato de comunicação para uma funcionalidade pequena. |
| TypeScript + Baileys | Escolhido: conexão WebSocket direta, sem Chromium, mesmo processo para mensagens e imagens. Tipagem estática facilita a transição de C#. |
| TypeScript + whatsapp-web.js | Alternativa com Puppeteer/navegador gerenciado, suporte a figurinhas, mas maior infraestrutura de execução. |

A escolha não significa que C# seja incapaz; reduz a quantidade de componentes para o caminho não oficial escolhido. Baileys disponível no npm: 7.0.0-rc14. Dependências diretas fixadas e package-lock versionável. Documentação do site pode evoluir antes do pacote; compilação local verifica as assinaturas utilizadas.

Fontes primárias:
- https://baileys.wiki/ — arquitetura e vinculação.
- https://baileys.wiki/messaging/media-messages — download e envio de mídia.
- https://baileys.wiki/authentication/session-management — persistência e advertência sobre o helper de arquivos.
- https://docs.wwebjs.dev/ — Puppeteer, recursos e risco de bloqueio.
- https://developers.facebook.com/docs/whatsapp/cloud-api — alternativa oficial.
- https://sharp.pixelplumbing.com/api-output/ — geração de WebP.
- https://github.com/WhatsApp/stickers — especificações de figurinhas.

## Hospedagem

O processo precisa ficar ativo, manter uma conexão de saída com WhatsApp e preservar as chaves de sessão em disco. Não precisa de domínio, porta HTTP pública, banco externo nem IA. Uma única réplica por conta. Valores em USD, antes de câmbio/impostos; não incluem a linha móvel. Tarifas consultadas, não orçamento fechado.

| Opção | Preço consultado | Avaliação para Felipe |
|---|---|---|
| Mac local | Sem nova assinatura de hospedagem | Melhor para desenvolver e testar agora. Para quando o Mac dorme, fica offline ou o processo encerra. |
| Railway Hobby | US$ 5/mês de mínimo, inclui US$ 5 em consumo; excedente cobrado | Recomendação para facilidade futura. Docker e volume persistente; medir consumo real e configurar limite/alerta. Não prometer teto de US$ 5. |
| Railway Free | US$ 5 de crédito no teste de 30 dias; depois US$ 1/mês de recursos, até 0,5 GB RAM e 0,5 GB de volume | Pode servir para experimento; a verba pode não sustentar um processo 24h. Não assumir operação contínua grátis. |
| DigitalOcean Droplet | US$ 4/mês por 512 MiB; US$ 6 por 1 GiB | Eu começaria em 1 GiB para margem de conversão. Boa para aprender Linux/Docker; exige atualizações, SSH, firewall e backup. |
| Render Free | Gratuito | Descartado para este desenho: dorme após 15 minutos sem tráfego de entrada e não tem disco persistente. Mensagens recebidas por conexão de saída não são webhook para acordá-lo. |
| Render pago | Compute + disco, conferir cotação no painel | Tecnicamente viável como worker persistente. Preço atual não estava legível na página dinâmica; sem valor inventado. Menos motivo para preferir ao Railway neste MVP. |

Recomendação: validar localmente primeiro; depois reforçar a sessão e testar Railway Hobby. Escolher VPS de US$ 6 se o objetivo incluir aprender administração de servidor. Não usar funções efêmeras/escala a zero para esta conexão contínua.

Fontes consultadas:
- https://railway.com/pricing
- https://docs.railway.com/volumes/reference
- https://www.digitalocean.com/pricing/droplets
- https://render.com/docs/free
- https://render.com/docs/disks
- https://render.com/pricing

## Antes de publicar

1. Teste real com o eSIM: QR, recebimento, entrega de figurinha e acesso não autorizado.
2. Testar reinício e reconexão sem novo QR, depois logout/revinculação.
3. Substituir helper de sessão por persistência transacional se for manter em produção.
4. Validar imagem Docker e permissões do volume na hospedagem escolhida.
5. Configurar uma única réplica, sem suspensão automática, sem endpoint público.
6. Configurar orçamento e proteger backups de sessão (credenciais).

Deploy, compra de hospedagem, criação no GitHub e envio de conteúdo pessoal não foram executados.
