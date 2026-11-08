@echo off
title PISTA - Liberar Porta 8888 no Firewall do Windows
echo ========================================================
echo  PISTA - Liberando a porta 8888 no Firewall do Windows
echo  (Necessario para que celulares na mesma rede Wi-Fi
echo   consigam abrir a tela de convidados: /guest)
echo ========================================================
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Solicitando permissao de Administrador...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo Adicionando regra de entrada no Firewall para a porta 8888...
netsh advfirewall firewall add rule name="PISTA - Conexao de Convidados (Porta 8888)" dir=in action=allow protocol=TCP localport=8888

if %errorlevel% equ 0 (
    echo.
    echo [SUCESSO] Porta 8888 liberada com sucesso no Firewall do Windows!
    echo Agora os celulares conectados na mesma rede Wi-Fi vao conseguir abrir o link.
) else (
    echo.
    echo [AVISO] Nao foi possivel adicionar a regra automaticamente.
)

echo.
pause

