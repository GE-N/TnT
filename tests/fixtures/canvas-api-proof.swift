import UIKit
@main class AppDelegate: UIResponder, UIApplicationDelegate {
 var window:UIWindow?
 func application(_ application:UIApplication,didFinishLaunchingWithOptions options:[UIApplication.LaunchOptionsKey:Any]?)->Bool {
  let window=UIWindow(frame:UIScreen.main.bounds);window.rootViewController=CanvasProofController();window.makeKeyAndVisible();self.window=window;return true
 }
}
class CanvasProofController:UIViewController {
 let state=UILabel();let notice=UILabel();let showNotice=UIButton(type:.system);let dismiss=UIButton(type:.system);let load=UIButton(type:.system)
 override func viewDidLoad(){
  super.viewDidLoad();view.backgroundColor = .systemBackground
  state.text="Home";state.accessibilityIdentifier="home";state.textAlignment = .center;state.frame=CGRect(x:30,y:150,width:330,height:60);view.addSubview(state)
  showNotice.setTitle("Open session notice",for:.normal);showNotice.frame=CGRect(x:30,y:240,width:330,height:50);showNotice.addTarget(self,action:#selector(openNotice),for:.touchUpInside);view.addSubview(showNotice)
  load.setTitle("Load page",for:.normal);load.frame=CGRect(x:30,y:310,width:330,height:50);load.addTarget(self,action:#selector(loadPage),for:.touchUpInside);view.addSubview(load)
  notice.text="Session notice";notice.accessibilityIdentifier="notice";notice.textAlignment = .center;notice.frame=CGRect(x:30,y:410,width:330,height:50);notice.isHidden=true;view.addSubview(notice)
  dismiss.setTitle("Dismiss session notice",for:.normal);dismiss.frame=CGRect(x:30,y:470,width:330,height:50);dismiss.addTarget(self,action:#selector(closeNotice),for:.touchUpInside);dismiss.isHidden=true;view.addSubview(dismiss)
 }
 @objc func openNotice(){notice.isHidden=false;dismiss.isHidden=false;load.isEnabled=false}
 @objc func closeNotice(){notice.isHidden=true;dismiss.isHidden=true;load.isEnabled=true}
 @objc func loadPage(){
  state.text="Loading";state.accessibilityIdentifier="loading";load.isEnabled=false
  URLSession.shared.dataTask(with:URL(string:"http://localhost:4320/items")!){data,response,error in
   let status=(response as? HTTPURLResponse)?.statusCode
   let code=(try? JSONSerialization.jsonObject(with:data ?? Data())) as? [String:Any]
   DispatchQueue.main.async {
    if status==500 && code?["code"] as? String=="MAINTENANCE" {self.state.text="Maintenance";self.state.accessibilityIdentifier="maintenance"}
    else if status==200 {self.state.text="Success";self.state.accessibilityIdentifier="success"}
    else {self.state.text="Network error";self.state.accessibilityIdentifier="network-error"}
    self.showNotice.isHidden=true;self.load.isHidden=true
   }
  }.resume()
 }
}
