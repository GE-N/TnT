import UIKit
@main class AppDelegate: UIResponder, UIApplicationDelegate {
 var window:UIWindow?
 func application(_ application:UIApplication,didFinishLaunchingWithOptions options:[UIApplication.LaunchOptionsKey:Any]?)->Bool {
  let window=UIWindow(frame:UIScreen.main.bounds)
  window.rootViewController=UINavigationController(rootViewController:HomeController())
  window.makeKeyAndVisible();self.window=window;return true
 }
}
class HomeController:UIViewController {
 let state=UILabel();var returned=false
 override func viewDidLoad(){
  super.viewDidLoad();title="Home";view.backgroundColor = .systemBackground
  navigationItem.backButtonTitle="Back"
  state.textAlignment = .center;state.frame=CGRect(x:30,y:180,width:330,height:60);view.addSubview(state)
  let open=UIButton(type:.system);open.setTitle("Coordinator",for:.normal);open.frame=CGRect(x:30,y:280,width:330,height:60)
  open.addTarget(self,action:#selector(openCoordinator),for:.touchUpInside);view.addSubview(open)
 }
 override func viewWillAppear(_ animated:Bool){super.viewWillAppear(animated);state.text=returned ? "Returned Home" : "Initial Home";state.accessibilityIdentifier=returned ? "home.returned" : "home.initial"}
 @objc func openCoordinator(){returned=true;navigationController?.pushViewController(CoordinatorController(),animated:true)}
}
class CoordinatorController:UIViewController {
 override func viewDidLoad(){
  super.viewDidLoad();title="Coordinator";view.backgroundColor = .systemBackground
  let identifier=UILabel();identifier.text="CF65D";identifier.accessibilityIdentifier="coordinator.fixed"
  identifier.textAlignment = .center;identifier.frame=CGRect(x:30,y:220,width:330,height:60);view.addSubview(identifier)
 }
}
