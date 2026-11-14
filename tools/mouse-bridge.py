"""
鼠标桥：常驻进程，从 stdin 读一行 JSON，做一次鼠标动作，回一行 JSON。

为什么要单独一个常驻进程（而不是每次起一个）：
每次起 Python 进程约 120ms，而拖一张牌要「按下 → 移动十几步 → 抬起」，
起三个进程就是一秒。常驻的话整套动作 300ms 以内。

为什么要 Python 而不是 Node：
Windows 上从 Node 发鼠标事件要么编 native 模块（要 VS 构建工具），
要么走 P/Invoke（PowerShell 的 Add-Type 在本机被安全策略拦了）。
Python 标准库的 ctypes 直接调 user32.dll，什么都不用装。

**这个文件只做「手替」，不做任何判断。**
该点哪里、该不该点，全在扩展那边决定 —— 那部分才需要看游戏状态。
单独拿出一个文件，是因为它是唯一一处会碰真实鼠标的代码，
出错代价最大（点到投降、点错牌），所以越薄越好审。

协议（一行一条）：
  {"cmd":"screen"}                       → {"ok":true,"w":2560,"h":1440}
  {"cmd":"pos"}                          → {"ok":true,"x":1346,"y":926}
  {"cmd":"drag","from":[x,y],"to":[x,y]} → {"ok":true}
  {"cmd":"click","at":[x,y]}             → {"ok":true}
  {"cmd":"move","at":[x,y]}              → {"ok":true}
  {"cmd":"quit"}                         → {"ok":true} 然后退出
"""
import ctypes
import json
import sys
import time

user32 = ctypes.windll.user32

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


class POINT(ctypes.Structure):
    _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]


def cursor():
    p = POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def move(x, y):
    user32.SetCursorPos(int(x), int(y))


def left_down():
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)


def left_up():
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)


def drag(src, dst, steps=18, hold=0.012):
    """
    按住拖过去。

    中间要分步移动，不能一次跳 —— 炉石靠「按下后指针在牌上移动一段」来判定
    「这张牌被拿起来了」。瞬移过去，游戏还停在「没抓住」的状态，松手就什么都不会发生。

    hold 是每步之间的停顿。太小（<5ms）动作会被吞，太大整套拖拽就慢了。
    """
    move(*src)
    time.sleep(0.06)          # 让游戏先看到指针停在这张牌上
    left_down()
    time.sleep(0.05)
    x1, y1 = src
    x2, y2 = dst
    for i in range(1, steps + 1):
        move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)
        time.sleep(hold)
    time.sleep(0.08)          # 松手前停一下，否则容易「拖到一半掉下去」
    left_up()


def click(at):
    move(*at)
    time.sleep(0.05)
    left_down()
    time.sleep(0.04)
    left_up()


def handle(msg):
    cmd = msg.get('cmd')
    if cmd == 'screen':
        return {'ok': True, 'w': user32.GetSystemMetrics(0), 'h': user32.GetSystemMetrics(1)}
    if cmd == 'pos':
        x, y = cursor()
        return {'ok': True, 'x': x, 'y': y}
    if cmd == 'move':
        move(*msg['at'])
        return {'ok': True}
    if cmd == 'click':
        click(msg['at'])
        return {'ok': True}
    if cmd == 'drag':
        drag(msg['from'], msg['to'])
        return {'ok': True}
    if cmd == 'quit':
        return {'ok': True, 'bye': True}
    return {'ok': False, 'error': f'unknown cmd {cmd}'}


def main():
    # 行缓冲：父进程发一条就要立刻收到，不能攒着。
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as exc:
            print(json.dumps({'ok': False, 'error': f'bad json: {exc}'}), flush=True)
            continue
        try:
            out = handle(msg)
        except Exception as exc:
            # 动作失败绝不能让桥退出 —— 下一次还要用。
            out = {'ok': False, 'error': str(exc)}
        print(json.dumps(out), flush=True)
        if out.get('bye'):
            break


if __name__ == '__main__':
    main()
